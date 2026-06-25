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
  }, [log])

  // Fetch workspaces when the Deploy step first appears.
  useEffect(() => {
    if (step === 'deploy' && !wsResult && !loadingWs) void loadWorkspaces()
  }, [step])

  const selectedEntry = gallery?.templates.find((t) => keyOf(t) === communitySel) ?? null

  async function create(): Promise<void> {
    setBusy(true)
    setError(null)
    setLog('')
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

  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  const urlValid = /^(https?:\/\/|git@|git\+)/i.test(url.trim())
  const canCreate =
    Boolean(slug) &&
    (source === 'builtin' ? Boolean(template) : customMode ? urlValid : Boolean(selectedEntry))

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
                    Built-in
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

                {source === 'builtin' ? (
                  loadingTemplates ? (
                    <div className="template-grid" aria-busy="true">
                      {Array.from({ length: 4 }).map((_, i) => (
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

              {(busy || log) && (
                <pre className="log-console log-console--sm" ref={logRef}>
                  {log || 'Starting…'}
                </pre>
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
