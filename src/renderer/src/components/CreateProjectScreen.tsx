import { useEffect, useId, useRef, useState, type JSX } from 'react'
import type {
  CommunityGallery,
  ProjectActionResult,
  ProjectLocationCheck,
  ProjectNameCheck,
  TeamActionResult,
  TeamWorkspace
} from '@shared/ipc'
import { useSuppressPreview } from '../overlay'
import type { ModelSelection } from '../modelSelection'
import { projectNameProblem } from '../projectName'
import { useMascotInstall } from './mascot/stage'
import { ModelPicker } from './models/ModelPicker'
import { displayPath } from './projectDisplay'

/** `scratch` = the Rayfin CLI's Universal App that grows into anything; `example` = a community template. */
type Start = 'scratch' | 'example'

/**
 * The Rayfin CLI's built-in Universal App (the CLI's "Use default template"). It
 * starts small with no database, and its capability router grows it into whatever
 * the user describes, so nobody picks an app shape up front.
 */
export const STARTER_TEMPLATE = 'universal-app'

interface Props {
  /** Abandon the flow (no project is created). */
  onCancel: () => void
  /** A project was created: the parent opens it in the workbench. */
  onCreated?: (result: ProjectActionResult) => void
  /** Team workspaces a new app can go into (experimental). */
  teamWorkspaces?: TeamWorkspace[]
  /** Preselect this team workspace as the destination. */
  initialTeamWorkspaceId?: string
  /** A team app was created; its pipeline deploys it. */
  onTeamCreated?: (result: TeamActionResult) => void
  /** Creating an app from something else (a Power BI report): shown in place of the examples. */
  source?: { label: string; detail: string }
  /** The project name to start with. */
  initialName?: string
  /** Start from this community example (its `path`, or its name): the gallery's Examples offer it. */
  initialExample?: string
  /** The Copilot model the new app's first turns use, chosen here (a report migration's). */
  model?: { value: ModelSelection; onChange: (next: ModelSelection) => void; onManageKeys?: () => void }
  /** The projects folder, where a new project goes unless another folder is chosen. */
  projectsFolder?: string
  /** Other folders earlier new projects went in, most recent first. */
  recentLocations?: string[]
}

const keyOf = (t: { path?: string; name: string }): string => t.path || t.name

/** A folder as Windows and macOS compare them: in any case, with either slash. */
const comparable = (path: string): string =>
  path.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** The coarse stages a scaffold goes through, in order. `done` is authoritative. */
type CreatePhase = 'preparing' | 'customizing' | 'installing' | 'finalizing' | 'done'

interface PhaseDef {
  id: CreatePhase
  label: string
  hint?: string
  /**
   * Loose, lowercase fragments that signal this stage has begun. Kept broad and
   * forgiving on purpose — see {@link markerPhase}.
   */
  markers: string[]
}

/**
 * The visible create stages. `finalizing` keys off our *own* backend `say()`
 * line ("Initializing git repository…"), which we control; `customizing` /
 * `installing` key off the upstream `npm create @microsoft/rayfin` scaffolder.
 * `done` is never marker-derived (see below).
 */
const CREATE_PHASES: PhaseDef[] = [
  { id: 'preparing', label: 'Preparing', markers: [] },
  { id: 'customizing', label: 'Customizing template', markers: ['customiz'] },
  {
    id: 'installing',
    label: 'Installing dependencies',
    hint: 'First run can take a minute or two.',
    markers: ['install']
  },
  { id: 'finalizing', label: 'Finishing up', markers: ['initializing git', 'git repository'] }
]

const PHASE_ORDER: CreatePhase[] = ['preparing', 'customizing', 'installing', 'finalizing', 'done']
const phaseRank = (p: CreatePhase): number => PHASE_ORDER.indexOf(p)

/**
 * Best-effort, **purely cosmetic** mapping of the cumulative create log to the
 * furthest stage reached. Hardened so upstream output changes can never break
 * or stall the actual create:
 *  - It never reports `done` — completion is driven solely by the backend
 *    result, so reworded/removed "finished" lines can't strand the wizard.
 *  - Markers are loose substrings; missing them only softens the indicator
 *    (the spinner + elapsed timer + {@link fallbackPhase} still convey motion).
 *  - Wrapped so a parsing slip degrades gracefully instead of throwing.
 */
function markerPhase(log: string): CreatePhase {
  try {
    const l = log.toLowerCase()
    let reached: CreatePhase = 'preparing'
    for (const def of CREATE_PHASES) {
      if (def.markers.length && def.markers.some((m) => l.includes(m))) reached = def.id
    }
    return reached
  } catch {
    return 'preparing'
  }
}

/**
 * Time-based floor so the indicator keeps advancing even if every upstream
 * output marker changes. Capped at `installing` (the dominant time sink) — it
 * never fabricates `finalizing`/`done`, which require a real signal/result.
 */
function fallbackPhase(elapsedSec: number, running: boolean): CreatePhase {
  if (!running) return 'preparing'
  if (elapsedSec >= 10) return 'installing'
  if (elapsedSec >= 3) return 'customizing'
  return 'preparing'
}

/**
 * The full-window create-a-project experience: name the app and pick where it
 * starts (ported from the old New Project dialog), then follow the scaffold.
 * The new app runs on this computer, so it opens in the workbench as soon as
 * it's created.
 */
export default function CreateProjectScreen({
  onCancel,
  onCreated,
  teamWorkspaces,
  initialTeamWorkspaceId,
  onTeamCreated,
  source,
  initialName,
  initialExample,
  model,
  projectsFolder,
  recentLocations
}: Props): JSX.Element {
  // The native preview webview floats above HTML; suppress it while this covers the body.
  useSuppressPreview()

  const teamTargets = (teamWorkspaces ?? []).filter((w) => !w.setup || w.setup.done)
  /** '' = this computer; otherwise a team workspace id. */
  const [destination, setDestination] = useState(
    initialTeamWorkspaceId && teamTargets.some((w) => w.id === initialTeamWorkspaceId)
      ? initialTeamWorkspaceId
      : ''
  )

  const [name, setName] = useState(initialName ?? '')
  /** The folder the project goes in; blank is the projects folder. */
  const [location, setLocation] = useState(projectsFolder ?? '')
  const [locationCheck, setLocationCheck] = useState<
    (ProjectLocationCheck & { key: string }) | null
  >(null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const locationId = useId()
  const [start, setStart] = useState<Start>(initialExample ? 'example' : 'scratch')
  const [gallery, setGallery] = useState<CommunityGallery | null>(null)
  const [loadingGallery, setLoadingGallery] = useState(false)
  const [galleryError, setGalleryError] = useState<string | null>(null)
  const [communitySel, setCommunitySel] = useState('')
  const [customMode, setCustomMode] = useState(false)
  const [url, setUrl] = useState('')
  const [templateName, setTemplateName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [log, setLog] = useState('')
  const [showDetails, setShowDetails] = useState(false)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [now, setNow] = useState(0)
  const [done, setDone] = useState(false)
  const logRef = useRef<HTMLPreElement>(null)
  const screenRef = useRef<HTMLDivElement>(null)

  // Ray keeps the user company through the slow scaffold and npm install.
  const mascot = useMascotInstall(
    destination ? 'team' : 'create',
    busy ? 'running' : done ? 'success' : error ? 'error' : 'idle',
    screenRef
  )

  // Esc abandons the flow, but never mid-create or once the app exists.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy && !done) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, done, onCancel])

  async function loadGallery(repoUrl?: string): Promise<void> {
    setLoadingGallery(true)
    setGalleryError(null)
    try {
      const res = await window.api.projects.communityTemplates(repoUrl)
      if (res.ok && res.gallery) {
        setGallery(res.gallery)
        const first = res.gallery.templates[0]
        const asked = res.gallery.templates.find((t) => keyOf(t) === initialExample)
        setCommunitySel(asked ? keyOf(asked) : first ? keyOf(first) : '')
      } else {
        setGallery(null)
        setGalleryError(res.error ?? 'Couldn’t load the community gallery.')
      }
    } finally {
      setLoadingGallery(false)
    }
  }

  // Fetch the default gallery the first time the user asks for an example.
  useEffect(() => {
    if (start === 'example' && !customMode && !gallery && !loadingGallery && !galleryError) {
      void loadGallery()
    }
  }, [start, customMode])

  useEffect(() => {
    const off = window.api.onProcLog((e) => {
      if (e.channel === 'create:project') setLog((prev) => prev + e.data)
    })
    return off
  }, [])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log, showDetails])

  // Tick a 1s elapsed clock while a create is in flight. This is the strongest
  // "still working" cue during the output-silent npm install — and it's
  // independent of any scaffolder/CLI log wording, so it survives upstream
  // output changes.
  useEffect(() => {
    if (!busy || startedAt == null) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [busy, startedAt])

  const selectedEntry = gallery?.templates.find((t) => keyOf(t) === communitySel) ?? null

  // The projects folder can arrive after the screen opens.
  useEffect(() => {
    if (projectsFolder) setLocation((current) => current || projectsFolder)
  }, [projectsFolder])

  /** The folder chosen for the project, when it isn't the projects folder. */
  const customLocation =
    !destination && location.trim() && comparable(location) !== comparable(projectsFolder ?? '')
      ? location.trim()
      : ''

  async function browse(): Promise<void> {
    const picked = await window.api.projects.pickFolder()
    if (picked) setLocation(picked)
  }

  /** Create the chosen folder when it doesn't exist yet. */
  async function createFolder(): Promise<void> {
    const path = customLocation
    setCreatingFolder(true)
    try {
      setLocationCheck({ ...(await window.api.projects.createLocation(path)), key: path })
    } catch {
      setLocationCheck({
        ok: false,
        missing: true,
        message: 'Couldn’t create the folder.',
        key: path
      })
    } finally {
      setCreatingFolder(false)
    }
  }

  async function create(): Promise<void> {
    setBusy(true)
    setError(null)
    setLog('')
    setDone(false)
    setShowDetails(false)
    setStartedAt(Date.now())
    setNow(Date.now())
    try {
      let tmpl = STARTER_TEMPLATE
      let tmplName: string | undefined
      if (start === 'example' && customMode) {
        tmpl = url.trim()
        tmplName = templateName.trim() || undefined
      } else if (start === 'example') {
        tmpl = selectedEntry?.repoUrl ?? gallery?.repoUrl ?? ''
        tmplName = selectedEntry?.name
      }
      if (destination) {
        const teamResult = await window.api.team.createProject(destination, {
          name,
          template: tmpl,
          templateName: tmplName
        })
        if (teamResult.project) {
          setDone(true)
          // The screen closes in the same moment, so tell Ray directly.
          mascot.succeed()
          onTeamCreated?.(teamResult)
        } else {
          setError(teamResult.error ?? 'Project creation failed.')
          setShowDetails(true)
        }
        return
      }
      const result = await window.api.projects.create({
        name,
        template: tmpl,
        templateName: tmplName,
        ...(customLocation ? { location: customLocation } : {})
      })
      if (result.ok) {
        setDone(true)
        // The workbench opens in the same moment, so tell Ray directly.
        mascot.succeed()
        onCreated?.(result)
      } else {
        setError(result.error ?? 'Project creation failed.')
        // Surface the raw output so the real failure (not just our summary) is
        // visible without an extra click.
        setShowDetails(true)
      }
    } finally {
      setBusy(false)
    }
  }

  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  /** The Rayfin CLI would refuse this name: said right away, so Create stays off. */
  const nameProblem = projectNameProblem(name)

  // Is the name free where the project will be saved (the projects folder, the
  // folder chosen instead, or the team workspace)? Checked shortly after typing
  // stops. Only a confirmed conflict blocks Create; creating still refuses a
  // taken folder on its own.
  const checkKey = `${destination}\u0000${customLocation}\u0000${name.trim()}`
  const [nameCheck, setNameCheck] = useState<(ProjectNameCheck & { key: string }) | null>(null)
  useEffect(() => {
    if (!slug || nameProblem || busy || done) return
    let stale = false
    const timer = window.setTimeout(() => {
      void (async () => {
        let result: ProjectNameCheck = { ok: true }
        try {
          result = await window.api.projects.checkName(
            name.trim(),
            destination || undefined,
            customLocation || undefined
          )
        } catch {
          // A failed check never blocks creating.
        }
        if (!stale) setNameCheck({ ...result, key: checkKey })
      })()
    }, 300)
    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [checkKey, slug, nameProblem, busy, done])
  const nameTaken = nameCheck?.key === checkKey && !nameCheck.ok ? (nameCheck.message ?? 'That name is taken.') : null
  const nameWarning = nameProblem ?? nameTaken

  // Can the chosen folder take the project? Checked shortly after typing stops;
  // a missing folder is offered for creating, and Create waits for an answer.
  useEffect(() => {
    if (!customLocation || busy || done) return
    let stale = false
    const timer = window.setTimeout(() => {
      void window.api.projects
        .checkLocation(customLocation)
        .then((result) => {
          if (!stale) setLocationCheck({ ...result, key: customLocation })
        })
        // A failed check doesn't block creating, which checks the folder again.
        .catch(() => {
          if (!stale) setLocationCheck({ ok: true, key: customLocation })
        })
    }, 300)
    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [customLocation, busy, done])
  const locationState =
    customLocation && locationCheck?.key === customLocation ? locationCheck : null
  const locationReady = !customLocation || Boolean(locationState?.ok)
  const projectsKey = comparable(projectsFolder ?? '')
  /** Quick picks: the projects folder, when another is chosen, then recent folders. */
  const locationChoices = [
    ...(customLocation && projectsFolder ? [projectsFolder] : []),
    ...(recentLocations ?? []).filter((path) => comparable(path) !== projectsKey)
  ]
    .filter((path) => comparable(path) !== comparable(location))
    .slice(0, 5)

  const urlValid = /^(https?:\/\/|git@|git\+)/i.test(url.trim())
  const canCreate =
    Boolean(slug) &&
    !nameWarning &&
    locationReady &&
    (start === 'scratch' || (customMode ? urlValid : Boolean(selectedEntry)))

  // ----- Create progress (cosmetic; completion is driven by `done`) -----
  const elapsedSec = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0
  const elapsedLabel = `${Math.floor(elapsedSec / 60)}:${String(elapsedSec % 60).padStart(2, '0')}`
  const detectedPhase = markerPhase(log)
  const fallback = fallbackPhase(elapsedSec, busy)
  // Never regress: take the furthest of the parsed marker and the time floor.
  const phase: CreatePhase = done
    ? 'done'
    : phaseRank(detectedPhase) >= phaseRank(fallback)
      ? detectedPhase
      : fallback
  const activeIdx =
    phase === 'done' ? CREATE_PHASES.length : CREATE_PHASES.findIndex((p) => p.id === phase)
  const activePhaseLabel =
    phase === 'done' ? 'Project ready' : (CREATE_PHASES[activeIdx]?.label ?? 'Preparing')
  const createFailed = !busy && !done && Boolean(error)
  const showProgress = busy || Boolean(log)
  /** The fields step aside while the app is created, and while the workbench opens it. */
  const hideFields = busy || done

  const heading = source ? 'New app from Power BI' : 'New project'
  const sub = hideFields
    ? `Setting up ${name.trim() || 'your app'}…`
    : source
      ? 'Name your app. Fabricator reads the report while it creates the app, then Copilot rebuilds it page by page.'
      : 'Give it a name. Next, describe what you want and Copilot builds it.'

  const head = (
    <header className="create-head" data-mascot-avoid="">
      <div className="create-head-text">
        <h1 className="create-title">{heading}</h1>
        <p className="create-sub">{sub}</p>
      </div>
    </header>
  )

  return (
    <div className="create-screen" ref={screenRef}>
      <div className="create-shell">
        {head}

        <div className="create-body" data-mascot-avoid="">
          <label className={`field${hideFields ? ' create-field-hidden' : ''}`}>
            <span className="field-label">Project name</span>
            <input
              className="field-input"
              type="text"
              value={name}
              autoFocus
              placeholder="My Rayfin App"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              disabled={busy}
              aria-invalid={nameWarning ? true : undefined}
              onChange={(e) => setName(e.target.value)}
            />
            {nameWarning ? (
              <span className="field-hint field-hint--warn" role="alert">
                {nameWarning}
              </span>
            ) : (
              slug && (
                <span className="field-hint">
                  Folder: <code>{slug}</code>
                </span>
              )
            )}
          </label>
          {teamTargets.length > 0 && (
            <label className={`field${hideFields ? ' create-field-hidden' : ''}`}>
              <span className="field-label">Where</span>
              <select
                className="field-input"
                value={destination}
                disabled={busy}
                onChange={(e) => setDestination(e.target.value)}
              >
                <option value="">Just me, on this computer</option>
                {teamTargets.map((w) => (
                  <option key={w.id} value={w.id}>
                    Team workspace: {w.name}
                  </option>
                ))}
              </select>
              <span className="field-hint">
                {destination
                  ? 'It runs on this computer while you build it. Your team sees it once you publish it.'
                  : 'It runs on this computer. Publish it to a Fabric workspace whenever you’re ready.'}
              </span>
            </label>
          )}
          {!destination && (
            <div className={`field${hideFields ? ' create-field-hidden' : ''}`}>
              <label className="field-label" htmlFor={locationId}>
                Location
              </label>
              <div className="create-location">
                <input
                  id={locationId}
                  className="field-input"
                  type="text"
                  value={location}
                  placeholder={projectsFolder || 'Your projects folder'}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={busy}
                  aria-invalid={locationState && !locationState.ok ? true : undefined}
                  onChange={(e) => setLocation(e.target.value)}
                />
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={busy}
                  onClick={() => void browse()}
                >
                  Browse…
                </button>
              </div>
              {locationState && !locationState.ok && (
                <span className="field-hint field-hint--warn create-location-problem" role="alert">
                  {locationState.message}
                  {locationState.missing && (
                    <button
                      type="button"
                      className="link-btn"
                      disabled={busy || creatingFolder}
                      onClick={() => void createFolder()}
                    >
                      {creatingFolder ? 'Creating…' : 'Create folder'}
                    </button>
                  )}
                </span>
              )}
              {locationChoices.length > 0 && (
                <div className="create-recents" role="group" aria-label="Recent locations">
                  <span className="create-recents-label" aria-hidden="true">
                    Recent
                  </span>
                  {locationChoices.map((path) => (
                    <button
                      key={path}
                      type="button"
                      className="create-recent"
                      title={path}
                      disabled={busy}
                      onClick={() => setLocation(path)}
                    >
                      {comparable(path) === projectsKey ? 'Projects folder' : displayPath(path)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className={`field${hideFields ? ' create-field-hidden' : ''}`}>
            {source ? (
              <>
                <div className="create-source">
                  <span className="field-label">{source.label}</span>
                  <span className="create-source-detail">{source.detail}</span>
                </div>
                {model && (
                  <div className="create-model">
                    <span className="field-label">Copilot model</span>
                    <ModelPicker
                      value={model.value}
                      disabled={busy}
                      onChange={model.onChange}
                      tiers
                      placement="down"
                      onManageKeys={model.onManageKeys}
                      label="Copilot model"
                    />
                    <span className="field-hint">
                      Copilot rebuilds the report with this model. You can change it in the chat
                      later.
                    </span>
                  </div>
                )}
              </>
            ) : start === 'scratch' ? (
              <p className="create-start">
                Want a head start?{' '}
                <button
                  type="button"
                  className="link-btn"
                  disabled={busy}
                  onClick={() => setStart('example')}
                >
                  Start from a community example
                </button>
              </p>
            ) : (
              <div className="create-examples-head">
                <span className="field-label">Start from an example</span>
                <button
                  type="button"
                  className="link-btn"
                  disabled={busy}
                  onClick={() => {
                    setStart('scratch')
                    setCustomMode(false)
                  }}
                >
                  Start from scratch instead
                </button>
              </div>
            )}

            {start === 'example' && !customMode && (
              <p className="template-caption">
                Ready-made apps from the Rayfin community. Pick one to build on.
              </p>
            )}

            {start === 'scratch' ? null : customMode ? (
              <div className="template-url">
                <input
                  className="field-input"
                  type="text"
                  value={url}
                  placeholder="https://github.com/owner/awesome-rayfin-template"
                  spellCheck={false}
                  disabled={busy}
                  onChange={(e) => setUrl(e.target.value)}
                />
                <span className="field-hint">
                  A git or tarball URL for a community (awesome-rayfin) template.
                </span>
                <input
                  className="field-input"
                  type="text"
                  value={templateName}
                  placeholder="Template name (optional, for multi-template repos)"
                  spellCheck={false}
                  disabled={busy}
                  onChange={(e) => setTemplateName(e.target.value)}
                />
                {url.trim() && !urlValid && (
                  <span className="field-hint field-hint--warn">
                    Enter a valid http(s) or git URL.
                  </span>
                )}
                <button
                  type="button"
                  className="link-btn"
                  disabled={busy}
                  onClick={() => setCustomMode(false)}
                >
                  ← Back to the examples
                </button>
              </div>
            ) : loadingGallery ? (
              <div className="template-grid" aria-busy="true">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="template-card template-card--skel">
                    <span className="skel-line skel-line--title" />
                    <span className="skel-line" />
                    <span className="skel-line skel-line--short" />
                  </div>
                ))}
              </div>
            ) : galleryError ? (
              <div className="gallery-empty">
                <p className="gallery-empty-msg">{galleryError}</p>
                <div className="gallery-empty-actions">
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={busy}
                    onClick={() => void loadGallery()}
                  >
                    Try again
                  </button>
                  <button
                    type="button"
                    className="link-btn"
                    disabled={busy}
                    onClick={() => setCustomMode(true)}
                  >
                    Use a custom URL
                  </button>
                </div>
              </div>
            ) : (
              <>
                {gallery && gallery.templates.length === 0 ? (
                  <div className="gallery-empty">
                    <p className="gallery-empty-msg">This gallery doesn’t have any examples yet.</p>
                  </div>
                ) : (
                  <div className="template-grid">
                    {gallery?.templates.map((t) => (
                      <button
                        key={keyOf(t)}
                        type="button"
                        disabled={busy}
                        className={`template-card${communitySel === keyOf(t) ? ' template-card--active' : ''}`}
                        onClick={() => setCommunitySel(keyOf(t))}
                      >
                        <span className="template-card-name">{t.name}</span>
                        <span className="template-card-desc">{t.description}</span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="gallery-footer">
                  <span className="field-hint">
                    From{' '}
                    <span className="gallery-source">
                      {gallery?.displayName || gallery?.repoUrl.replace(/^https?:\/\//, '')}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="link-btn"
                    disabled={busy}
                    onClick={() => setCustomMode(true)}
                  >
                    Use a custom URL
                  </button>
                </div>
              </>
            )}
          </div>

          {showProgress && (
            <div className="create-progress" aria-busy={busy}>
              <span className="sr-only" role="status" aria-live="polite">
                {busy ? activePhaseLabel : done ? 'Project ready' : ''}
              </span>
              <ol className="create-phases">
                {CREATE_PHASES.map((p, i) => {
                  const state =
                    phase === 'done' || i < activeIdx
                      ? 'done'
                      : i === activeIdx
                        ? 'active'
                        : 'pending'
                  return (
                    <li
                      key={p.id}
                      className={`create-phase create-phase--${state}${
                        createFailed && state === 'active' ? ' create-phase--failed' : ''
                      }`}
                    >
                      <span className="create-phase-ico" aria-hidden="true">
                        {state === 'active' ? (
                          busy ? (
                            <span className="ws-spinner" />
                          ) : createFailed ? (
                            '✕'
                          ) : null
                        ) : state === 'done' ? (
                          '✓'
                        ) : null}
                      </span>
                      <span className="create-phase-text">
                        <span className="create-phase-label">{p.label}</span>
                        {p.id === 'installing' && state === 'active' && (
                          <span className="create-phase-hint">
                            {elapsedSec > 75
                              ? 'Still working — large dependency trees take a little longer.'
                              : p.hint}
                          </span>
                        )}
                      </span>
                    </li>
                  )
                })}
              </ol>

              <div className="create-progress-meta">
                <span className="create-elapsed" aria-hidden="true">
                  {busy ? `${elapsedLabel} elapsed` : done ? 'Done' : ''}
                </span>
                <button
                  type="button"
                  className="link-btn create-progress-toggle"
                  onClick={() => setShowDetails((v) => !v)}
                >
                  {showDetails ? 'Hide details' : 'Show details'}
                </button>
              </div>

              {showDetails && (
                <pre className="log-console log-console--sm create-progress-details" ref={logRef}>
                  {log || 'Starting…'}
                </pre>
              )}
            </div>
          )}

          {error && <div className="alert alert--error">{error}</div>}
        </div>

        <footer className="create-foot" data-mascot-avoid="">
          <button className="btn btn--ghost" onClick={onCancel} disabled={busy || done}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            onClick={create}
            disabled={busy || done || !canCreate}
          >
            {busy ? 'Creating…' : done ? 'Opening…' : 'Create project'}
          </button>
        </footer>
      </div>
    </div>
  )
}
