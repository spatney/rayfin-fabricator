import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SkillInfo, StudioProject } from '@shared/ipc'

// Lazy so Monaco (pulled in by the preview modal) stays out of the main bundle.
const SkillPreviewModal = lazy(() => import('./SkillPreviewModal'))

interface Props {
  project: StudioProject
  /** Called after a skill is added/removed so the parent can refresh Code/History. */
  onChanged: () => void
}

interface SkillGroup {
  /** Stable key for the group. */
  key: string
  title: string
  skills: SkillInfo[]
}

/** Bucket the flat skill list into display groups: always-on, categories, custom. */
function groupSkills(skills: SkillInfo[]): SkillGroup[] {
  const base = skills.filter((s) => s.base)
  const custom = skills.filter((s) => s.custom)
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

  if (custom.length) {
    groups.push({ key: '__custom', title: 'Your custom skills', skills: custom })
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

  return (
    <div className="skills">
      <div className="skills-head">
        <div>
          <h2 className="skills-title">Skills</h2>
          <p className="skills-sub">
            Skills teach your app builder good habits. Turn one on and it applies to
            everything you build next — no code required.
          </p>
        </div>
        {skills && <span className="skills-count">{activeCount} active</span>}
      </div>

      {notice && <div className="skills-notice">{notice}</div>}
      {error && <div className="alert alert--error skills-error">{error}</div>}

      {!skills ? (
        <div className="skills-loading">Loading skills…</div>
      ) : (
        <div className="skills-groups">
          {groups.map((group) => (
            <section className="skills-group" key={group.key}>
              <div className="skills-group-head">
                <h3 className="skills-group-title">{group.title}</h3>
              </div>
              <div className="skills-grid">
                {group.skills.map((skill) => {
                  const isBusy = busy === skill.id
                  return (
                    <div
                      key={skill.id}
                      className={`skill-card${skill.active ? ' skill-card--active' : ''}`}
                    >
                      <div className="skill-card-top">
                        <span className="skill-icon" aria-hidden="true">
                          {skill.icon}
                        </span>
                        {skill.base ? (
                          <span className="skill-flag skill-flag--base">Always on</span>
                        ) : skill.custom ? (
                          <span className="skill-flag skill-flag--custom">Custom</span>
                        ) : skill.active ? (
                          <span className="skill-flag skill-flag--on">Active</span>
                        ) : null}
                      </div>
                      <h3 className="skill-name">{skill.title}</h3>
                      <p className="skill-desc">{skill.description}</p>
                      <div className="skill-card-foot">
                        <button
                          className="btn btn--xs btn--ghost"
                          onClick={() => setPreview(skill)}
                          title="View the raw SKILL.md"
                        >
                          Preview
                        </button>
                        {skill.base ? (
                          <span
                            className="skill-locked"
                            title="The core Rayfin skill is always on."
                          >
                            🔒 Built-in
                          </span>
                        ) : (
                          <button
                            className={`btn btn--sm${skill.active ? '' : ' btn--primary'}`}
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
    </div>
  )
}
