import { useEffect, useRef, useState } from 'react'
import type {
  CommunityGallery,
  FabricWorkspacesResult,
  ProjectActionResult,
  TemplateInfo
} from '@shared/ipc'
import { useSuppressPreview } from '../overlay'
import DeploymentCreateForm from './DeploymentCreateForm'

type Mode = 'create' | 'deploy'
type Step = 'details' | 'deploy'

interface Props {
  /** 'create' runs Details → Deploy; 'deploy' shows only the Deploy step for the active project. */
  mode: Mode
  /** Display name of the active project (used by the deploy-only header). */
  projectName?: string
  /** Abandon the flow from the Details step (no project is created). */
  onCancel: () => void
  /** A project was just scaffolded; the parent refreshes its list but keeps this screen up. */
  onCreated?: (result: ProjectActionResult) => void
  /** Deploy `name` into `workspaceId`, then leave the flow. */
  onDeploy: (name: string, workspaceId: string) => void
  /** Skip deploying and enter the workbench (chat lands gated until a deployment exists). */
  onContinueWithoutDeploy: () => void
  /** True while a `rayfin up` is already streaming for this project (disables the submit). */
  deploying?: boolean
}

const keyOf = (t: { path?: string; name: string }): string => t.path || t.name

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
 * The full-window create-a-project experience. In `create` mode it runs a two-step
 * wizard — Details (name + template, ported from the old New Project dialog) then
 * Deploy (pick a Fabric workspace via the shared {@link DeploymentCreateForm}). In
 * `deploy` mode it shows only the Deploy step, used by the chat hard-gate CTA to
 * guide a freshly created project to its first deployment before chatting.
 */
export default function CreateProjectScreen({
  mode,
  projectName,
  onCancel,
  onCreated,
  onDeploy,
  onContinueWithoutDeploy,
  deploying = false
}: Props): JSX.Element {
  // The native preview webview floats above HTML; suppress it while this covers the body.
  useSuppressPreview()

  const [step, setStep] = useState<Step>(mode === 'deploy' ? 'deploy' : 'details')
  const [createdName, setCreatedName] = useState<string | undefined>(projectName)

  // ----- Details step (ported from NewProjectModal) -----
  const [templates, setTemplates] = useState<TemplateInfo[]>([])
  const [loadingTemplates, setLoadingTemplates] = useState(true)
  const [name, setName] = useState('')
  const [source, setSource] = useState<'builtin' | 'community'>('builtin')
  const [template, setTemplate] = useState('')
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

  // ----- Deploy step -----
  const [wsResult, setWsResult] = useState<FabricWorkspacesResult | null>(null)
  const [loadingWs, setLoadingWs] = useState(false)

  async function loadWorkspaces(): Promise<void> {
    setLoadingWs(true)
    try {
      setWsResult(await window.api.fabric.listWorkspaces())
    } catch (err) {
      setWsResult({ ok: false, error: String(err) })
    } finally {
      setLoadingWs(false)
    }
  }

  // Esc abandons the Details step (never mid-create); on the Deploy step it skips.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (step === 'details') {
        if (!busy) onCancel()
      } else if (!deploying) {
        onContinueWithoutDeploy()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step, busy, deploying, onCancel, onContinueWithoutDeploy])

  useEffect(() => {
    if (mode !== 'create') return
    void window.api.projects
      .templates()
      .then((t) => {
        setTemplates(t)
        if (t.length) setTemplate(t[0].name)
      })
      .finally(() => setLoadingTemplates(false))
  }, [mode])

  async function loadGallery(repoUrl?: string): Promise<void> {
    setLoadingGallery(true)
    setGalleryError(null)
    try {
      const res = await window.api.projects.communityTemplates(repoUrl)
      if (res.ok && res.gallery) {
        setGallery(res.gallery)
        setCommunitySel(res.gallery.templates[0] ? keyOf(res.gallery.templates[0]) : '')
      } else {
        setGallery(null)
        setGalleryError(res.error ?? 'Couldn’t load the community gallery.')
      }
    } finally {
      setLoadingGallery(false)
    }
  }

  // Lazily fetch the default gallery the first time the user opens the Community tab.
  useEffect(() => {
    if (source === 'community' && !customMode && !gallery && !loadingGallery && !galleryError) {
      void loadGallery()
    }
  }, [source, customMode])

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

  // Fetch workspaces when the Deploy step first appears.
  useEffect(() => {
    if (step === 'deploy' && !wsResult && !loadingWs) void loadWorkspaces()
  }, [step])

  const selectedEntry = gallery?.templates.find((t) => keyOf(t) === communitySel) ?? null

  async function create(): Promise<void> {
    setBusy(true)
    setError(null)
    setLog('')
    setDone(false)
    setShowDetails(false)
    setStartedAt(Date.now())
    setNow(Date.now())
    try {
      let tmpl: string
      let tmplName: string | undefined
      if (source === 'builtin') {
        tmpl = template
        tmplName = undefined
      } else if (customMode) {
        tmpl = url.trim()
        tmplName = templateName.trim() || undefined
      } else {
        tmpl = selectedEntry?.repoUrl ?? gallery?.repoUrl ?? ''
        tmplName = selectedEntry?.name
      }
      const result = await window.api.projects.create({
        name,
        template: tmpl,
        templateName: tmplName
      })
      if (result.ok) {
        setDone(true)
        setCreatedName(result.project?.name ?? name.trim())
        onCreated?.(result)
        setStep('deploy')
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

  const urlValid = /^(https?:\/\/|git@|git\+)/i.test(url.trim())
  const canCreate =
    Boolean(slug) &&
    (source === 'builtin' ? Boolean(template) : customMode ? urlValid : Boolean(selectedEntry))

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

  const heading =
    step === 'deploy'
      ? mode === 'create'
        ? 'Deploy your app'
        : 'Create your first deployment'
      : 'New Rayfin project'
  const sub =
    step === 'deploy'
      ? `Publish ${createdName || 'your app'} to a Fabric workspace to start building with chat.`
      : 'Name your app and pick a template to start from.'
  const skipLabel = mode === 'deploy' ? 'Maybe later' : 'Continue without deploying →'

  return (
    <div className="create-screen">
      <div className="create-shell">
        <header className="create-head">
          <div className="create-head-text">
            <h1 className="create-title">{heading}</h1>
            <p className="create-sub">{sub}</p>
          </div>
          {mode === 'create' && (
            <ol className="create-steps" aria-label="Progress">
              <li
                className={`create-step${
                  step === 'details' ? ' create-step--active' : ' create-step--done'
                }`}
              >
                <span className="create-step-no">1</span>
                <span className="create-step-label">Details</span>
              </li>
              <li className={`create-step${step === 'deploy' ? ' create-step--active' : ''}`}>
                <span className="create-step-no">2</span>
                <span className="create-step-label">Deploy</span>
              </li>
            </ol>
          )}
        </header>

        {step === 'details' ? (
          <>
            <div className="create-body">
              <label className="field">
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
                  onChange={(e) => setName(e.target.value)}
                />
                {slug && (
                  <span className="field-hint">
                    Folder: <code>{slug}</code>
                  </span>
                )}
              </label>

              <div className="field">
                <span className="field-label">Template</span>
                <div className="seg">
                  <button
                    type="button"
                    disabled={busy}
                    className={`seg-btn${source === 'builtin' ? ' seg-btn--active' : ''}`}
                    onClick={() => setSource('builtin')}
                  >
                    Featured
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className={`seg-btn${source === 'community' ? ' seg-btn--active' : ''}`}
                    onClick={() => setSource('community')}
                  >
                    Community
                  </button>
                </div>

                <p className="template-caption">
                  {source === 'builtin'
                    ? 'Curated, ready-to-run starting points — each deploys straight to a Fabric test workspace, then you keep building with chat.'
                    : 'Start from any community template published in an awesome-rayfin GitHub repo.'}
                </p>

                {source === 'builtin' ? (
                  loadingTemplates ? (
                    <div className="template-grid" aria-busy="true">
                      {Array.from({ length: 3 }).map((_, i) => (
                        <div key={i} className="template-card template-card--skel">
                          <span className="skel-line skel-line--title" />
                          <span className="skel-line" />
                          <span className="skel-line skel-line--short" />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="template-grid">
                      {templates.map((t) => (
                        <button
                          key={t.name}
                          type="button"
                          disabled={busy}
                          className={`template-card${template === t.name ? ' template-card--active' : ''}`}
                          onClick={() => setTemplate(t.name)}
                        >
                          <span className="template-card-name">{t.displayName}</span>
                          {t.defaultPreviewMode === 'fabric' && (
                            <span
                              className="template-card-badge"
                              title="Opens embedded in the Fabric portal view by default — you can switch to the direct view any time."
                            >
                              Opens in Fabric view
                            </span>
                          )}
                          <span className="template-card-desc">{t.description}</span>
                        </button>
                      ))}
                    </div>
                  )
                ) : customMode ? (
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
                      ← Back to the gallery
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
                    <div className="gallery-footer">
                      <span className="field-hint">
                        From{' '}
                        <code>
                          {gallery?.displayName || gallery?.repoUrl.replace(/^https?:\/\//, '')}
                        </code>
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
                    <pre
                      className="log-console log-console--sm create-progress-details"
                      ref={logRef}
                    >
                      {log || 'Starting…'}
                    </pre>
                  )}
                </div>
              )}

              {error && <div className="alert alert--error">{error}</div>}
            </div>

            <footer className="create-foot">
              <button className="btn btn--ghost" onClick={onCancel} disabled={busy}>
                Cancel
              </button>
              <button className="btn btn--primary" onClick={create} disabled={busy || !canCreate}>
                {busy ? 'Creating…' : 'Create project'}
              </button>
            </footer>
          </>
        ) : (
          <div className="create-body create-body--deploy">
            <div className="create-deploy">
              <DeploymentCreateForm
                wsResult={wsResult}
                loadingWs={loadingWs}
                onReload={() => void loadWorkspaces()}
                running={deploying}
                submitLabel="Deploy app"
                busyLabel="Deploying…"
                defaultName="Development"
                onSubmit={onDeploy}
              />
              <div className="create-skip">
                <button type="button" className="link-btn" onClick={onContinueWithoutDeploy}>
                  {skipLabel}
                </button>
                <span className="create-skip-hint">
                  You can deploy any time, but chat stays locked until your app has a deployment.
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
