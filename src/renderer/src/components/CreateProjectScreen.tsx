import { useEffect, useRef, useState } from 'react'
import type {
  CommunityGallery,
  FabricWorkspacesResult,
  ProjectActionResult,
  StudioProject,
  TemplateInfo
} from '@shared/ipc'
import { useSuppressPreview } from '../overlay'
import DeploymentCreateForm from './DeploymentCreateForm'
import CreateProgress from './CreateProgress'

type Mode = 'create' | 'deploy'
type Step = 'details' | 'migrate' | 'deploy'

/**
 * Configuration that turns the create flow into a Power BI migration. When set,
 * the wizard runs three steps — Details (name your app, defaulted to the report
 * name, then the *standard* create + install using the data-app template), Migrate
 * (download the report's code + semantic model into the new project), then the
 * standard Deploy step. Injected so migrate reuses the exact same `projects.create`
 * + deploy path as a normal create.
 */
export interface MigrateSetup {
  /** Human name for the created project (the report's display name). */
  projectName: string
  /**
   * Download the report definition + semantic model into the freshly-created
   * project. Runs after create, before Deploy. Progress is reported per sub-step
   * via `onProgress`: `'code'` covers the PBIR + semantic-model download, and
   * `'pages'` covers exporting the report to PDF and rasterizing each page into a
   * chat attachment. A `status` marks a sub-step terminal (`'done'` / `'error'` /
   * `'skipped'`); omitting it means the sub-step is still `'running'`. Returns an
   * error string to abort (the screen rolls back the project), or null on success.
   */
  onFetchReportCode: (
    project: StudioProject,
    onProgress: (phase: MigratePhase, detail: string, status?: MigrateSubStatus) => void
  ) => Promise<string | null>
  /** Delete the just-created project (rollback) if fetch fails or the user cancels. */
  onRollback: (project: StudioProject) => Promise<void>
}

/** The two sub-steps of the migrate fetch, reported independently to the UI. */
export type MigratePhase = 'code' | 'pages'
/** Terminal state of a migrate sub-step (absence ⇒ still running). */
export type MigrateSubStatus = 'done' | 'error' | 'skipped'

/** UI state for one migrate sub-step row: its current detail + lifecycle state. */
interface MigrateSub {
  detail: string
  status: 'pending' | 'running' | MigrateSubStatus
}

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
  /** Notify the parent that a Fabric sign-in just succeeded (refresh app auth). */
  onSignedIn?: () => void
  /** When set, runs the create flow as a Power BI report migration (see {@link MigrateSetup}). */
  migrate?: MigrateSetup
}

const keyOf = (t: { path?: string; name: string }): string => t.path || t.name

/** The bundled data-app template a migration always scaffolds from. */
const DATA_APP_TEMPLATE = 'fabricator-dataapp'

/**
 * The full-window create-a-project experience. In `create` mode it runs a two-step
 * wizard — Details (name + template, ported from the old New Project dialog) then
 * Deploy (pick a Fabric workspace via the shared {@link DeploymentCreateForm}). In
 * `deploy` mode it shows only the Deploy step, used by the chat hard-gate CTA to
 * guide a freshly created project to its first deployment before chatting. When a
 * {@link MigrateSetup} is supplied, the Details step instead runs a Power BI report
 * migration (standard create + install, then a report-code fetch) before Deploy.
 */
export default function CreateProjectScreen({
  mode,
  projectName,
  onCancel,
  onCreated,
  onDeploy,
  onContinueWithoutDeploy,
  onSignedIn,
  deploying = false,
  migrate
}: Props): JSX.Element {
  // The native preview webview floats above HTML; suppress it while this covers the body.
  useSuppressPreview()

  const [step, setStep] = useState<Step>(mode === 'deploy' ? 'deploy' : 'details')
  const [createdName, setCreatedName] = useState<string | undefined>(projectName)

  // ----- Details step (ported from NewProjectModal) -----
  const [templates, setTemplates] = useState<TemplateInfo[]>([])
  const [loadingTemplates, setLoadingTemplates] = useState(true)
  // In migrate mode the app name defaults to the report's display name (editable).
  const [name, setName] = useState(() => migrate?.projectName ?? '')
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
  const [done, setDone] = useState(false)

  // ----- Migrate sub-step (report-code fetch, between create and deploy) -----
  const [fetching, setFetching] = useState(false)
  // The migrate fetch runs two visible sub-steps: download the report + model
  // code, then export the report to PDF and rasterize each page into a chat
  // attachment. Each tracks its own status/detail so both render as a row.
  const [codeSub, setCodeSub] = useState<MigrateSub>({ detail: '', status: 'pending' })
  const [pagesSub, setPagesSub] = useState<MigrateSub>({ detail: '', status: 'pending' })
  // The project scaffolded by a migrate create, kept so a fetch failure or Cancel
  // can roll it back (and a fetch retry reuses it instead of re-scaffolding).
  const createdProjectRef = useRef<StudioProject | null>(null)

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

  // Fetch workspaces when the Deploy step first appears.
  useEffect(() => {
    if (step === 'deploy' && !wsResult && !loadingWs) void loadWorkspaces()
  }, [step])

  const selectedEntry = gallery?.templates.find((t) => keyOf(t) === communitySel) ?? null

  async function create(): Promise<void> {
    setBusy(true)
    setError(null)
    setDone(false)
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
      }
    } finally {
      setBusy(false)
    }
  }

  // ----- Migrate: run the *standard* create (data-app template, named by the
  // Details field, with the same numbered-name collision retry a normal create
  // uses), advance to the Migrate step, download the report's code into the
  // project, then advance to the Deploy step. -----

  async function runFetch(project: StudioProject): Promise<boolean> {
    if (!migrate) return true
    setFetching(true)
    setError(null)
    setCodeSub({ detail: 'Getting your report’s code…', status: 'running' })
    setPagesSub({ detail: 'Waiting for the report code…', status: 'pending' })
    const err = await migrate.onFetchReportCode(project, (phase, detail, status) => {
      const next: MigrateSub = { detail, status: status ?? 'running' }
      if (phase === 'code') setCodeSub(next)
      else setPagesSub(next)
    })
    setFetching(false)
    if (err) {
      setError(err)
      // Attribute the failure to whichever sub-step was still running.
      setCodeSub((s) => (s.status === 'running' ? { detail: err, status: 'error' } : s))
      setPagesSub((s) => (s.status === 'running' ? { detail: err, status: 'error' } : s))
      return false
    }
    // Defensive: settle any sub-step the reporter left non-terminal on success.
    setCodeSub((s) => (s.status === 'done' ? s : { ...s, status: 'done' }))
    setPagesSub((s) =>
      s.status === 'running' ? { ...s, status: 'done' } : s.status === 'pending' ? { detail: 'Skipped.', status: 'skipped' } : s
    )
    return true
  }

  async function createMigrate(): Promise<void> {
    if (!migrate) return
    const base = name.trim() || migrate.projectName
    setBusy(true)
    setError(null)
    setDone(false)
    let project: StudioProject | null = null
    try {
      let created = await window.api.projects.create({
        name: base,
        template: DATA_APP_TEMPLATE
      })
      for (
        let n = 2;
        !created.ok && created.error && /already exists/i.test(created.error) && n <= 50;
        n++
      ) {
        created = await window.api.projects.create({
          name: `${base} ${n}`,
          template: DATA_APP_TEMPLATE
        })
      }
      if (!created.ok || !created.project) {
        setError(created.error ?? 'Could not create a project for the report.')
        return
      }
      project = created.project
      createdProjectRef.current = project
      setDone(true)
      setCreatedName(project.name)
      onCreated?.(created)
    } finally {
      setBusy(false)
    }
    if (!project) return
    setStep('migrate')
    if (await runFetch(project)) setStep('deploy')
  }

  // Retry the failed part only: a failed create re-scaffolds; a failed fetch (the
  // project already exists) just re-downloads the report code.
  async function retryMigrate(): Promise<void> {
    const existing = createdProjectRef.current
    if (existing) {
      if (await runFetch(existing)) setStep('deploy')
    } else {
      await createMigrate()
    }
  }

  // Abandon a migration: roll back the scaffolded project (if any) so no empty
  // folder is left behind, then leave the flow.
  async function cancelMigrate(): Promise<void> {
    const proj = createdProjectRef.current
    if (proj && migrate) {
      createdProjectRef.current = null
      await migrate.onRollback(proj)
    }
    onCancel()
  }

  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  const urlValid = /^(https?:\/\/|git@|git\+)/i.test(url.trim())
  const canCreate = migrate
    ? Boolean(slug)
    : Boolean(slug) &&
      (source === 'builtin' ? Boolean(template) : customMode ? urlValid : Boolean(selectedEntry))

  // ----- Create progress (cosmetic; completion is driven by `done`) -----
  const createFailed = !busy && !done && Boolean(error)
  // A migration's report-code fetch failed *after* a successful create — surfaced
  // inline on the fetch row (with a Try again that re-downloads, not re-creates).
  const fetchFailed = Boolean(migrate) && done && !fetching && Boolean(error)

  // Wizard steps for the header progress rail (migrate inserts a Migrate step).
  const stepOrder: Step[] = migrate ? ['details', 'migrate', 'deploy'] : ['details', 'deploy']
  const curStepIdx = stepOrder.indexOf(step)
  const stepClass = (s: Step): string => {
    const i = stepOrder.indexOf(s)
    return `create-step${
      i === curStepIdx ? ' create-step--active' : i < curStepIdx ? ' create-step--done' : ''
    }`
  }

  const heading =
    step === 'deploy'
      ? mode === 'create'
        ? 'Deploy your app'
        : 'Create your first deployment'
      : migrate
        ? 'Migrate Power BI report'
        : 'New Rayfin project'
  const sub =
    step === 'deploy'
      ? `Publish ${createdName || 'your app'} to a Fabric workspace to start building with chat.`
      : step === 'migrate'
        ? `Getting ${createdName || 'the report'}’s code…`
        : busy
          ? `Setting up ${name.trim() || 'your app'}…`
          : migrate
            ? 'Name your app — we’ll migrate the report into it.'
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
              <li className={stepClass('details')}>
                <span className="create-step-no">1</span>
                <span className="create-step-label">Details</span>
              </li>
              {migrate && (
                <li className={stepClass('migrate')}>
                  <span className="create-step-no">2</span>
                  <span className="create-step-label">Migrate</span>
                </li>
              )}
              <li className={stepClass('deploy')}>
                <span className="create-step-no">{migrate ? 3 : 2}</span>
                <span className="create-step-label">Deploy</span>
              </li>
            </ol>
          )}
        </header>

        {step === 'details' ? (
          <>
            <div className="create-body">
              <label className={`field${busy ? ' create-field-hidden' : ''}`}>
                <span className="field-label">App name</span>
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

              {!migrate && (
                <>
                  <div className={`field${busy ? ' create-field-hidden' : ''}`}>
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
                </>
              )}

              <CreateProgress running={busy} done={done} failed={createFailed} />

              {error && <div className="alert alert--error">{error}</div>}
            </div>

            <footer className="create-foot">
              {migrate ? (
                <>
                  <button
                    className="btn btn--ghost"
                    onClick={() => void cancelMigrate()}
                    disabled={busy}
                  >
                    Cancel
                  </button>
                  {createFailed ? (
                    <button
                      className="btn btn--primary"
                      onClick={() => void retryMigrate()}
                      disabled={busy}
                    >
                      Try again
                    </button>
                  ) : (
                    <button
                      className="btn btn--primary"
                      onClick={() => void createMigrate()}
                      disabled={busy || !canCreate}
                    >
                      {busy ? 'Creating…' : 'Create app'}
                    </button>
                  )}
                </>
              ) : (
                <>
                  <button className="btn btn--ghost" onClick={onCancel} disabled={busy}>
                    Cancel
                  </button>
                  <button
                    className="btn btn--primary"
                    onClick={create}
                    disabled={busy || !canCreate}
                  >
                    {busy ? 'Creating…' : 'Create project'}
                  </button>
                </>
              )}
            </footer>
          </>
        ) : step === 'migrate' ? (
          <>
            <div className="create-body">
              {(
                [
                  { key: 'code', label: 'Get report code (definition + semantic model)', sub: codeSub },
                  { key: 'pages', label: 'Capture report pages (PDF → images)', sub: pagesSub }
                ] as const
              ).map(({ key, label, sub }) => (
                <div key={key} className={`migrate-fetch migrate-fetch--${sub.status}`}>
                  <span className="migrate-fetch-ico" aria-hidden="true">
                    {sub.status === 'error'
                      ? '✕'
                      : sub.status === 'done'
                        ? '✓'
                        : sub.status === 'skipped'
                          ? '–'
                          : sub.status === 'pending'
                            ? '·'
                            : <span className="ws-spinner" />}
                  </span>
                  <span className="migrate-fetch-body">
                    <span className="migrate-fetch-label">{label}</span>
                    <span className="migrate-fetch-detail">{sub.detail}</span>
                  </span>
                </div>
              ))}
            </div>

            <footer className="create-foot">
              <button
                className="btn btn--ghost"
                onClick={() => void cancelMigrate()}
                disabled={fetching}
              >
                Cancel
              </button>
              {fetchFailed && (
                <button
                  className="btn btn--primary"
                  onClick={() => void retryMigrate()}
                  disabled={fetching}
                >
                  Try again
                </button>
              )}
            </footer>
          </>
        ) : (
          <div className="create-body create-body--deploy">
            <div className="create-deploy">
              <DeploymentCreateForm
                wsResult={wsResult}
                loadingWs={loadingWs}
                onReload={() => void loadWorkspaces()}
                onSignedIn={onSignedIn}
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
