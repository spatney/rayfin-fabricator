import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CustomSkillActionResult, SkillInfo, StudioProject } from '@shared/ipc'

// Lazy so Monaco (pulled in by the preview / author modals) stays out of the main bundle.
const SkillPreviewModal = lazy(() => import('./SkillPreviewModal'))
const CustomSkillModal = lazy(() => import('./CustomSkillModal'))
const ConfirmModal = lazy(() => import('./ConfirmModal'))

interface Props {
  project: StudioProject
  /** Called after a skill is added/removed so the parent can refresh Code/History. */
  onChanged: () => void
}

interface SkillGroup {
  /** Stable key for the group. */
  key: string
  title: string
  /** Optional explanatory line under the group title. */
  hint?: string
  /** The reusable custom-skill library section (rendered even when empty). */
  library?: boolean
  skills: SkillInfo[]
}

/**
 * Bucket the flat skill list into display groups: always-on, catalog categories,
 * the reusable custom-skill **library** (its own always-visible section), then any
 * skills the builder authored directly in this app.
 */
function groupSkills(skills: SkillInfo[]): SkillGroup[] {
  const base = skills.filter((s) => s.base)
  const library = skills.filter((s) => s.library)
  const localCustom = skills.filter((s) => s.custom && !s.library)
  const catalog = skills.filter((s) => !s.base && !s.custom)

  const groups: SkillGroup[] = []
  if (base.length) {
    groups.push({ key: '__base', title: 'Always on', skills: base })
  }

  // Catalog skills grouped by category, preserving first-seen order.
  for (const skill of catalog) {
    const name = skill.category ?? 'More'
    let group = groups.find((g) => g.key === `cat:${name}`)
    if (!group) {
      group = { key: `cat:${name}`, title: name, skills: [] }
      groups.push(group)
    }
    group.skills.push(skill)
  }

  // Your reusable library — a dedicated section for skills you've saved to reuse.
  if (library.length) {
    groups.push({
      key: '__library',
      title: 'Your skill library',
      hint: 'Custom skills you saved to reuse across apps. Turn one on to use it in this app.',
      library: true,
      skills: library
    })
  }

  if (localCustom.length) {
    groups.push({
      key: '__custom',
      title: 'Added in this app',
      hint: 'Skills the builder created directly in this app.',
      skills: localCustom
    })
  }
  return groups
}

/**
 * The Skills tab: a friendly, grouped catalog of app-building "skills" the user can
 * switch on per project. Each skill is guidance the AI builder applies to everything
 * it builds next; toggling one writes the project's agent instructions and commits.
 * The base Rayfin skill is always on and can't be removed. Any skill can be previewed
 * (its raw SKILL.md) before turning it on.
 */
export default function SkillsView({ project, onChanged }: Props): JSX.Element {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [preview, setPreview] = useState<SkillInfo | null>(null)
  /** null = closed; new (with a library default) = create; edit = edit a skill. */
  const [authoring, setAuthoring] = useState<
    { kind: 'new'; toLibrary: boolean } | { kind: 'edit'; skill: SkillInfo } | null
  >(null)
  const [deleting, setDeleting] = useState<SkillInfo | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async () => {
    try {
      setError(null)
      const list = await window.api.skills.list(project.id)
      setSkills(list)
    } catch (err) {
      setError(String(err))
    }
  }, [project.id])

  useEffect(() => {
    setSkills(null)
    void load()
  }, [load])

  useEffect(() => {
    return () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current)
    }
  }, [])

  const flash = useCallback((message: string) => {
    setNotice(message)
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(null), 3500)
  }, [])

  const toggle = useCallback(
    async (skill: SkillInfo) => {
      if (skill.base || busy) return
      const next = !skill.active
      setBusy(skill.id)
      setError(null)
      try {
        const result = await window.api.skills.set(project.id, skill.id, next)
        setSkills(result.skills)
        if (result.ok) {
          flash(
            next
              ? `Added “${skill.title}” — saved to your app.`
              : `Removed “${skill.title}” — saved to your app.`
          )
          onChanged()
        } else if (result.error) {
          setError(result.error)
        }
      } catch (err) {
        setError(String(err))
      } finally {
        setBusy(null)
      }
    },
    [project.id, busy, flash, onChanged]
  )

  const groups = useMemo(() => (skills ? groupSkills(skills) : []), [skills])
  const activeCount = skills?.filter((s) => s.active).length ?? 0

  // After a save/import/promote, refresh this project's list. When editing a skill
  // that's already active here, re-copy it so the project's copy picks up the edit.
  const handleSaved = useCallback(
    async (result: CustomSkillActionResult) => {
      const editedId = result.id
      const wasActive = editedId ? skills?.find((s) => s.id === editedId)?.active : false
      if (editedId && wasActive) {
        try {
          await window.api.skills.set(project.id, editedId, true)
        } catch {
          /* best-effort re-sync */
        }
      }
      onChanged()
      await load()
      flash('Saved to your skills.')
    },
    [skills, project.id, load, onChanged, flash]
  )

  const promote = useCallback(
    async (skill: SkillInfo) => {
      if (busy) return
      setBusy(skill.id)
      setError(null)
      try {
        const result = await window.api.customSkills.promote(project.id, skill.id)
        if (result.ok) {
          flash(`Saved “${skill.title}” to your skill library.`)
          await load()
        } else if (result.error) {
          setError(result.error)
        }
      } catch (err) {
        setError(String(err))
      } finally {
        setBusy(null)
      }
    },
    [busy, project.id, flash, load]
  )

  const confirmDelete = useCallback(async () => {
    if (!deleting) return
    setDeleteBusy(true)
    setError(null)
    try {
      const result = await window.api.customSkills.remove(deleting.id)
      if (result.ok) {
        flash(`Deleted “${deleting.title}” from your custom skills.`)
        setDeleting(null)
        await load()
      } else if (result.error) {
        setError(result.error)
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setDeleteBusy(false)
    }
  }, [deleting, load, flash])

  return (
    <div className="skills">
      <div className="skills-head">
        <div>
          <h2 className="skills-title">Skills</h2>
          <p className="skills-sub">
            Skills teach your app builder good habits. Turn one on and it applies to everything you
            build next — no code required.
          </p>
        </div>
        <div className="skills-head-actions">
          {skills && <span className="skills-count">{activeCount} active</span>}
          <button
            className="btn btn--sm"
            onClick={() => setAuthoring({ kind: 'new', toLibrary: false })}
            title="Add or upload your own custom skill"
          >
            + Add custom skill
          </button>
        </div>
      </div>

      {notice && <div className="skills-notice">{notice}</div>}
      {error && <div className="alert alert--error skills-error">{error}</div>}

      {!skills ? (
        <div className="skills-loading">Loading skills…</div>
      ) : (
        <div className="skills-groups">
          {groups.map((group) => (
            <section
              className={`skills-group${group.library ? ' skills-group--library' : ''}`}
              key={group.key}
            >
              <div className="skills-group-head">
                <h3 className="skills-group-title">{group.title}</h3>
              </div>
              {group.hint && <p className="skills-group-hint">{group.hint}</p>}
              <div className="skills-grid">
                {group.skills.map((skill) => {
                  const isBusy = busy === skill.id
                  return (
                    <div
                      key={skill.id}
                      className={`skill-row${skill.active ? ' skill-row--active' : ''}`}
                    >
                      <span className="skill-icon" aria-hidden="true">
                        {skill.icon}
                      </span>
                      <div className="skill-row-body">
                        <h3 className="skill-name">{skill.title}</h3>
                        <p className="skill-desc" title={skill.description}>
                          {skill.description}
                        </p>
                      </div>
                      <div className="skill-row-actions">
                        {skill.base ? (
                          <span className="skill-flag skill-flag--base">Always on</span>
                        ) : skill.active ? (
                          <span className="skill-flag skill-flag--on">Active</span>
                        ) : null}
                        {!skill.library && (
                          <button
                            className="btn btn--xs btn--ghost"
                            onClick={() => setPreview(skill)}
                            title="View the raw SKILL.md"
                          >
                            Preview
                          </button>
                        )}
                        {skill.library && (
                          <>
                            <button
                              className="btn btn--xs btn--ghost"
                              onClick={() => setAuthoring({ kind: 'edit', skill })}
                              title="View or edit this skill's SKILL.md"
                            >
                              Edit
                            </button>
                            <button
                              className="btn btn--xs btn--ghost skill-delete"
                              onClick={() => setDeleting(skill)}
                              title="Delete this skill from your library"
                            >
                              Delete
                            </button>
                          </>
                        )}
                        {skill.custom && !skill.library && (
                          <button
                            className="btn btn--xs btn--ghost"
                            onClick={() => void promote(skill)}
                            disabled={isBusy}
                            title="Save this skill to your library so you can use it in other apps"
                          >
                            Save to library
                          </button>
                        )}
                        {skill.base ? (
                          <span
                            className="skill-locked"
                            title="The core Rayfin skill is always on."
                          >
                            🔒 Built-in
                          </span>
                        ) : (
                          <button
                            className={`btn btn--xs skill-row-toggle${
                              skill.active ? '' : ' btn--primary'
                            }`}
                            onClick={() => void toggle(skill)}
                            disabled={isBusy}
                          >
                            {isBusy ? 'Saving…' : skill.active ? 'Remove' : 'Add'}
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      {preview && (
        <Suspense fallback={null}>
          <SkillPreviewModal
            projectId={project.id}
            skill={preview}
            onClose={() => setPreview(null)}
          />
        </Suspense>
      )}

      {authoring && (
        <Suspense fallback={null}>
          <CustomSkillModal
            projectId={project.id}
            editing={
              authoring.kind === 'edit'
                ? {
                    id: authoring.skill.id,
                    title: authoring.skill.title,
                    description: authoring.skill.description,
                    icon: authoring.skill.icon
                  }
                : null
            }
            defaultToLibrary={authoring.kind === 'new' ? authoring.toLibrary : false}
            onClose={() => setAuthoring(null)}
            onSaved={handleSaved}
          />
        </Suspense>
      )}

      {deleting && (
        <Suspense fallback={null}>
          <ConfirmModal
            title="Delete custom skill?"
            message={
              <>
                Delete “{deleting.title}” from your skill library? Apps that already use it keep
                their copy — this only removes it from your reusable library.
              </>
            }
            confirmLabel="Delete"
            danger
            busy={deleteBusy}
            busyLabel="Deleting…"
            onConfirm={() => void confirmDelete()}
            onCancel={() => (deleteBusy ? undefined : setDeleting(null))}
          />
        </Suspense>
      )}
    </div>
  )
}
