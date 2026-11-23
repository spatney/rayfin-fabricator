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
import { translator, useTranslation } from '../i18n'
import { Codicon } from './icons'
import Skeleton from './Skeleton'
import SkillInspector, { SkillsOverview, type SkillCounts } from './skills/SkillInspector'
import { SkillMark, SkillSwitch, sourceOf } from './skills/presentation'
import './skills/skills.css'

// Lazy so Monaco (pulled in by the preview / author modals) stays out of the main bundle.
const SkillPreviewModal = lazy(() => import('./SkillPreviewModal'))
const CustomSkillModal = lazy(() => import('./CustomSkillModal'))
const ConfirmModal = lazy(() => import('./ConfirmModal'))

type SkillsT = ReturnType<typeof translator<'skills'>>

interface Props {
  project: StudioProject
  /** Called after a skill is added/removed so the parent can refresh Code/History. */
  onChanged: () => void
}

type Filter = 'all' | 'on' | 'off'

const FILTERS = [
  { id: 'all', label: 'filters.all' },
  { id: 'on', label: 'filters.on' },
  { id: 'off', label: 'filters.off' }
] as const satisfies ReadonlyArray<{ id: Filter; label: string }>

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
function groupSkills(skills: SkillInfo[], t: SkillsT): SkillGroup[] {
  const groups: SkillGroup[] = []
  const base = skills.filter((s) => s.base)
  if (base.length) {
    groups.push({ key: '__base', title: t('groups.alwaysOn'), hint: t('groups.alwaysOnHint'), skills: base })
  }
  for (const skill of skills.filter((s) => sourceOf(s) === 'catalog')) {
    const key = `cat:${skill.category ?? 'More'}`
    let group = groups.find((g) => g.key === key)
    if (!group) {
      group = { key, title: skill.category ?? t('groups.more'), skills: [] }
      groups.push(group)
    }
    group.skills.push(skill)
  }
  const library = skills.filter((s) => s.library)
  if (library.length) {
    groups.push({
      key: '__library',
      title: t('groups.library'),
      hint: t('groups.libraryHint'),
      skills: library
    })
  }
  const app = skills.filter((s) => sourceOf(s) === 'app')
  if (app.length) {
    groups.push({
      key: '__app',
      title: t('groups.app'),
      hint: t('groups.appHint'),
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
  const { t } = useTranslation('skills')
  return (
    <div className={`skl-card${selected ? ' skl-card--selected' : ''}`}>
      <button type="button" className="skl-card-main" aria-pressed={selected} onClick={() => onSelect(skill)}>
        <SkillMark skill={skill} />
        <span className="skl-card-text">
          <span className="skl-card-title">{skill.title}</span>
          <span className="skl-card-desc">{skill.description}</span>
          {skill.outdated && skill.active && (
            <span className="skl-card-flag">{t('skill.updateAvailable')}</span>
          )}
        </span>
      </button>
      {source === 'rayfin' ? (
        <span className="skl-card-side skl-lock" title={t('skill.managed')}>
          <Codicon name="lock" />
          <span className="sr-only">{t('skill.alwaysOn')}</span>
        </span>
      ) : source !== 'app' ? (
        <span className="skl-card-side">
          <SkillSwitch
            on={skill.active}
            busy={busy}
            label={t('skill.use', { title: skill.title })}
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
  const { t } = useTranslation('skills')
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
        next ? t('toasts.turnedOn', { title: skill.title }) : t('toasts.turnedOff', { title: skill.title })
      )
    },
    [busy, updatingAll, setSkill, t]
  )

  const update = useCallback(
    (skill: SkillInfo) => {
      if (busy || updatingAll) return
      void setSkill(skill, true, t('toasts.updated', { title: skill.title }))
    },
    [busy, updatingAll, setSkill, t]
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
          setError(result.error ?? t('toasts.updateFailed', { title: skill.title }))
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
        flash(t('toasts.updatedCount', { count: updated }))
        onChanged()
      }
    }
  }, [outdated, busy, updatingAll, project.id, flash, onChanged, t])

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
      flash(t('toasts.saved'))
    },
    [skills, project.id, load, onChanged, flash, t]
  )

  const promote = useCallback(
    async (skill: SkillInfo) => {
      if (busy) return
      setBusy(skill.id)
      setError(null)
      try {
        const result = await window.api.customSkills.promote(project.id, skill.id)
        if (result.ok) {
          flash(t('toasts.savedToLibrary', { title: skill.title }))
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
    [busy, project.id, flash, load, t]
  )

  const confirmDelete = useCallback(async () => {
    if (!deleting) return
    setDeleteBusy(true)
    setError(null)
    try {
      const result = await window.api.customSkills.remove(deleting.id)
      if (result.ok) {
        flash(t('toasts.deleted', { title: deleting.title }))
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
  }, [deleting, load, flash, t])

  const confirmRemove = useCallback(async () => {
    if (!removing) return
    setRemoveBusy(true)
    const removed = await setSkill(removing, false, t('toasts.removed', { title: removing.title }))
    setRemoveBusy(false)
    setRemoving(null)
    if (removed) setSelectedId(null)
  }, [removing, setSkill, t])

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
        (skills ?? []).filter((s) => (filter === 'all' || (filter === 'on') === s.active) && matches(s, trimmed)),
        t
      ),
    [skills, filter, trimmed, t]
  )
  const selected = skills?.find((s) => s.id === selectedId) ?? null

  return (
    <div className="skl">
      <header className="skl-head">
        <div className="skl-head-title">
          <span className="skl-head-glyph" aria-hidden="true">
            <Codicon name="mortar-board" />
          </span>
          <h2 className="skl-title">{t('view.title')}</h2>
          <span className="skl-subtitle">{t('view.subtitle')}</span>
        </div>
        <div className="skl-tools">
          <div className="skl-search">
            <Codicon name="search" className="skl-search-ico" />
            <input
              className="skl-search-input"
              value={query}
              placeholder={t('view.search')}
              aria-label={t('view.search')}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query) {
                  e.preventDefault()
                  setQuery('')
                }
              }}
            />
            {query && (
              <button
                type="button"
                className="skl-search-clear"
                aria-label={t('view.clearSearch')}
                onClick={() => setQuery('')}
              >
                <Codicon name="close" />
              </button>
            )}
          </div>
          <div className="skl-tabs" role="radiogroup" aria-label={t('view.show')}>
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                role="radio"
                aria-checked={filter === f.id}
                className={`skl-tab${filter === f.id ? ' skl-tab--on' : ''}`}
                onClick={() => setFilter(f.id)}
              >
                {t(f.label)}
                {skills && <span className="skl-tab-count">{filterCount[f.id]}</span>}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="model-tool-btn"
            onClick={() => setAuthoring({ kind: 'new' })}
            title={t('view.newSkillTitle')}
          >
            <Codicon name="add" /> {t('view.newSkill')}
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
                {trimmed
                  ? t('empty.noMatch', { query: trimmed })
                  : filter === 'on'
                    ? t('empty.noneOn')
                    : t('empty.allOn')}
              </strong>
              {trimmed ? (
                <button type="button" className="skl-link" onClick={() => setQuery('')}>
                  {t('view.clearSearch')}
                </button>
              ) : (
                <button type="button" className="skl-link" onClick={() => setFilter('all')}>
                  {t('empty.showAll')}
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
            title={t('deleteDialog.title')}
            message={t('deleteDialog.message', { title: deleting.title })}
            confirmLabel={t('actions.delete')}
            danger
            busy={deleteBusy}
            busyLabel={t('status.deleting')}
            onConfirm={() => void confirmDelete()}
            onCancel={() => (deleteBusy ? undefined : setDeleting(null))}
          />
        </Suspense>
      )}

      {removing && (
        <Suspense fallback={null}>
          <ConfirmModal
            title={t('removeDialog.title')}
            message={
              removing.promotable
                ? t('removeDialog.messageSaveFirst', { title: removing.title })
                : t('removeDialog.message', { title: removing.title })
            }
            confirmLabel={t('actions.remove')}
            danger
            busy={removeBusy}
            busyLabel={t('removeDialog.removing')}
            onConfirm={() => void confirmRemove()}
            onCancel={() => (removeBusy ? undefined : setRemoving(null))}
          />
        </Suspense>
      )}
    </div>
  )
}
