import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react'
import type { CustomSkillActionResult, SkillInfo, StudioProject } from '@shared/ipc'
import { Codicon } from './icons'
import Skeleton from './Skeleton'
import SkillInspector, { SkillsOverview, type SkillCounts } from './skills/SkillInspector'
import { SkillMark, SkillSwitch, sourceOf } from './skills/presentation'
import './skills/skills.css'

// Lazy so Monaco (pulled in by the preview / author modals) stays out of the main bundle.
const SkillPreviewModal = lazy(() => import('./SkillPreviewModal'))
const CustomSkillModal = lazy(() => import('./CustomSkillModal'))
const ConfirmModal = lazy(() => import('./ConfirmModal'))

interface Props {
  project: StudioProject
  /** Called after a skill is added/removed so the parent can refresh Code/History. */
  onChanged: () => void
}

type Filter = 'all' | 'on' | 'off'

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'on', label: 'On' },
  { id: 'off', label: 'Off' }
]

interface SkillGroup {
  key: string
  title: string
  hint?: string
  skills: SkillInfo[]
}

/**
 * Bucket skills into display groups: Rayfin's always-on skills, the catalog by
 * category, the reusable library, then skills that live only in this app.
 */
function groupSkills(skills: SkillInfo[]): SkillGroup[] {
  const groups: SkillGroup[] = []
  const base = skills.filter((s) => s.base)
  if (base.length) {
    groups.push({ key: '__base', title: 'Always on', hint: 'Core guidance managed by Rayfin.', skills: base })
  }
  for (const skill of skills.filter((s) => sourceOf(s) === 'catalog')) {
    const name = skill.category ?? 'More'
    let group = groups.find((g) => g.key === `cat:${name}`)
    if (!group) {
      group = { key: `cat:${name}`, title: name, skills: [] }
      groups.push(group)
    }
    group.skills.push(skill)
  }
  const library = skills.filter((s) => s.library)
  if (library.length) {
    groups.push({
      key: '__library',
      title: 'Your skill library',
      hint: 'Your reusable skills. Turning one on copies it into this app.',
      skills: library
    })
  }
  const app = skills.filter((s) => sourceOf(s) === 'app')
  if (app.length) {
    groups.push({
      key: '__app',
      title: 'Added in this app',
      hint: 'Skills that live only in this app, such as the ones its template came with.',
      skills: app
    })
  }
  return groups
}

/** Every word of the query appears in the skill's name, description, id or category. */
function matches(skill: SkillInfo, query: string): boolean {
  if (!query) return true
  const text = `${skill.title} ${skill.description} ${skill.id} ${skill.category ?? ''}`.toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => text.includes(word))
}

function countSkills(skills: SkillInfo[]): SkillCounts {
  const builtIn = skills.filter((s) => sourceOf(s) === 'catalog')
  const library = skills.filter((s) => s.library)
  return {
    on: skills.filter((s) => s.active).length,
    always: skills.filter((s) => s.base).length,
    builtIn: builtIn.length,
    builtInOn: builtIn.filter((s) => s.active).length,
    library: library.length,
    libraryOn: library.filter((s) => s.active).length,
    appOnly: skills.filter((s) => sourceOf(s) === 'app').length
  }
}

function SkillCard({
  skill,
  selected,
  busy,
  onSelect,
  onToggle
}: {
  skill: SkillInfo
  selected: boolean
  busy: boolean
  onSelect: (skill: SkillInfo) => void
  onToggle: (skill: SkillInfo) => void
}): JSX.Element {
  const source = sourceOf(skill)
  return (
    <div className={`skl-card${selected ? ' skl-card--selected' : ''}`}>
      <button type="button" className="skl-card-main" aria-pressed={selected} onClick={() => onSelect(skill)}>
        <SkillMark skill={skill} />
        <span className="skl-card-text">
          <span className="skl-card-title">{skill.title}</span>
          <span className="skl-card-desc">{skill.description}</span>
          {skill.outdated && skill.active && <span className="skl-card-flag">Update available</span>}
        </span>
      </button>
      {source === 'rayfin' ? (
        <span className="skl-card-side skl-lock" title="Managed by Rayfin. Always on.">
          <Codicon name="lock" />
          <span className="sr-only">Always on</span>
        </span>
      ) : source !== 'app' ? (
        <span className="skl-card-side">
          <SkillSwitch
            on={skill.active}
            busy={busy}
            label={`Use ${skill.title} in this app`}
            onChange={() => onToggle(skill)}
          />
        </span>
      ) : null}
    </div>
  )
}

/**
 * The Skills tab: the guidance Copilot follows while it builds this app. Rayfin's
 * own skills are always on; built-in and library skills switch on and off; skills
 * that came with the app can be saved to the library or removed. Turning a skill
 * on writes its SKILL.md into the app and commits it, so it shows in History.
 * Selecting a skill shows what it teaches beside the grid.
 */
export default function SkillsView({ project, onChanged }: Props): JSX.Element {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [updatingAll, setUpdatingAll] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [preview, setPreview] = useState<SkillInfo | null>(null)
  /** null = closed; new = create; edit = edit a library skill. */
  const [authoring, setAuthoring] = useState<{ kind: 'new' } | { kind: 'edit'; skill: SkillInfo } | null>(null)
  const [deleting, setDeleting] = useState<SkillInfo | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [removing, setRemoving] = useState<SkillInfo | null>(null)
  const [removeBusy, setRemoveBusy] = useState(false)
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
    setSelectedId(null)
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

  /** Turn a built-in or library skill on or off, or (on) write its latest version. */
  const setSkill = useCallback(
    async (skill: SkillInfo, active: boolean, done: string): Promise<boolean> => {
      setBusy(skill.id)
      setError(null)
      try {
        const result = await window.api.skills.set(project.id, skill.id, active)
        setSkills(result.skills)
        if (result.ok) {
          flash(done)
          onChanged()
          return true
        }
        if (result.error) setError(result.error)
      } catch (err) {
        setError(String(err))
      } finally {
        setBusy(null)
      }
      return false
    },
    [project.id, flash, onChanged]
  )

  const toggle = useCallback(
    (skill: SkillInfo) => {
      if (skill.base || busy || updatingAll) return
      const next = !skill.active
      void setSkill(
        skill,
        next,
        next ? `Turned on “${skill.title}”. Saved to this app.` : `Turned off “${skill.title}”. Saved to this app.`
      )
    },
    [busy, updatingAll, setSkill]
  )

  const update = useCallback(
    (skill: SkillInfo) => {
      if (busy || updatingAll) return
      void setSkill(skill, true, `Updated “${skill.title}”.`)
    },
    [busy, updatingAll, setSkill]
  )

  const outdated = useMemo(() => (skills ?? []).filter((s) => s.outdated && s.active), [skills])

  const updateAll = useCallback(async () => {
    if (!outdated.length || busy || updatingAll) return
    setUpdatingAll(true)
    setError(null)
    let latest: SkillInfo[] | null = null
    let updated = 0
    try {
      for (const skill of outdated) {
        setBusy(skill.id)
        const result = await window.api.skills.set(project.id, skill.id, true)
        latest = result.skills
        if (!result.ok) {
          setError(result.error ?? `Couldn’t update “${skill.title}”.`)
          break
        }
        updated += 1
      }
    } catch (err) {
      setError(String(err))
    } finally {
      if (latest) setSkills(latest)
      setBusy(null)
      setUpdatingAll(false)
      if (updated > 0) {
        flash(updated === 1 ? 'Updated 1 skill.' : `Updated ${updated} skills.`)
        onChanged()
      }
    }
  }, [outdated, busy, updatingAll, project.id, flash, onChanged])

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
        flash(`Deleted “${deleting.title}” from your skill library.`)
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

  const confirmRemove = useCallback(async () => {
    if (!removing) return
    setRemoveBusy(true)
    const removed = await setSkill(removing, false, `Removed “${removing.title}” from this app.`)
    setRemoveBusy(false)
    setRemoving(null)
    if (removed) setSelectedId(null)
  }, [removing, setSkill])

  // Esc closes the details, unless a dialog is open (it handles Esc itself).
  const dialogOpen = Boolean(preview || authoring || deleting || removing)
  useEffect(() => {
    if (!selectedId || dialogOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) setSelectedId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, dialogOpen])

  const trimmed = query.trim()
  const counts = useMemo(() => countSkills(skills ?? []), [skills])
  const total = skills?.length ?? 0
  const filterCount: Record<Filter, number> = { all: total, on: counts.on, off: total - counts.on }
  const groups = useMemo(
    () =>
      groupSkills(
        (skills ?? []).filter((s) => (filter === 'all' || (filter === 'on') === s.active) && matches(s, trimmed))
      ),
    [skills, filter, trimmed]
  )
  const selected = skills?.find((s) => s.id === selectedId) ?? null

  return (
    <div className="skl">
      <header className="skl-head">
        <div className="skl-head-title">
          <span className="skl-head-glyph" aria-hidden="true">
            <Codicon name="mortar-board" />
          </span>
          <h2 className="skl-title">Skills</h2>
          <span className="skl-subtitle">Guidance Copilot follows while it builds this app</span>
        </div>
        <div className="skl-tools">
          <div className="skl-search">
            <Codicon name="search" className="skl-search-ico" />
            <input
              className="skl-search-input"
              value={query}
              placeholder="Search skills"
              aria-label="Search skills"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query) {
                  e.preventDefault()
                  setQuery('')
                }
              }}
            />
            {query && (
              <button type="button" className="skl-search-clear" aria-label="Clear search" onClick={() => setQuery('')}>
                <Codicon name="close" />
              </button>
            )}
          </div>
          <div className="skl-tabs" role="radiogroup" aria-label="Show">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                role="radio"
                aria-checked={filter === f.id}
                className={`skl-tab${filter === f.id ? ' skl-tab--on' : ''}`}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
                {skills && <span className="skl-tab-count">{filterCount[f.id]}</span>}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="model-tool-btn"
            onClick={() => setAuthoring({ kind: 'new' })}
            title="Write or upload your own skill"
          >
            <Codicon name="add" /> New skill
          </button>
        </div>
      </header>

      <div className="skl-body">
        <div className="skl-main" aria-busy={!skills}>
          {notice && (
            <div className="skl-notice" role="status">
              <Codicon name="check" /> {notice}
            </div>
          )}
          {error && <div className="alert alert--error skl-error">{error}</div>}

          {!skills ? (
            <div className="skl-loading">
              <Skeleton rows={6} avatar />
            </div>
          ) : groups.length === 0 ? (
            <div className="skl-empty">
              <strong>
                {trimmed ? `No skills match “${trimmed}”` : filter === 'on' ? 'No skills are on' : 'Every skill is on'}
              </strong>
              {trimmed ? (
                <button type="button" className="skl-link" onClick={() => setQuery('')}>
                  Clear search
                </button>
              ) : (
                <button type="button" className="skl-link" onClick={() => setFilter('all')}>
                  Show all skills
                </button>
              )}
            </div>
          ) : (
            groups.map((group) => (
              <section className="skl-group" key={group.key} aria-label={group.title}>
                <div className="skl-lane">
                  <h3>{group.title}</h3>
                  <span className="skl-lane-count">{group.skills.length}</span>
                  {group.hint && <span className="skl-lane-hint">{group.hint}</span>}
                </div>
                <div className="skl-grid">
                  {group.skills.map((skill) => (
                    <SkillCard
                      key={skill.id}
                      skill={skill}
                      selected={skill.id === selectedId}
                      busy={busy === skill.id}
                      onSelect={(s) => setSelectedId((id) => (id === s.id ? null : s.id))}
                      onToggle={toggle}
                    />
                  ))}
                </div>
              </section>
            ))
          )}
        </div>

        {selected ? (
          <SkillInspector
            key={selected.id}
            projectId={project.id}
            skill={selected}
            busy={busy === selected.id}
            onClose={() => setSelectedId(null)}
            onToggle={toggle}
            onUpdate={update}
            onRemove={setRemoving}
            onViewSource={setPreview}
            onEdit={(skill) => setAuthoring({ kind: 'edit', skill })}
            onDelete={setDeleting}
            onSaveToLibrary={(skill) => void promote(skill)}
          />
        ) : skills ? (
          <SkillsOverview
            counts={counts}
            updates={outdated.length}
            updating={updatingAll}
            onUpdateAll={() => void updateAll()}
          />
        ) : null}
      </div>

      {preview && (
        <Suspense fallback={null}>
          <SkillPreviewModal projectId={project.id} skill={preview} onClose={() => setPreview(null)} />
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
            defaultToLibrary={false}
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
                Delete “{deleting.title}” from your skill library? Apps that already use it keep their copy. This only
                removes it from your reusable library.
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

      {removing && (
        <Suspense fallback={null}>
          <ConfirmModal
            title="Remove skill from this app?"
            message={
              <>
                Copilot stops using “{removing.title}” in this app. It isn’t in your skill library, so to get it back
                you’d restore it from History.
                {removing.promotable && ' Save it to your library first if you want to reuse it.'}
              </>
            }
            confirmLabel="Remove"
            danger
            busy={removeBusy}
            busyLabel="Removing…"
            onConfirm={() => void confirmRemove()}
            onCancel={() => (removeBusy ? undefined : setRemoving(null))}
          />
        </Suspense>
      )}
    </div>
  )
}
