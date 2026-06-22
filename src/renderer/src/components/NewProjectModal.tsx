import { useEffect, useRef, useState } from 'react'
import type { CommunityGallery, ProjectActionResult, TemplateInfo } from '@shared/ipc'
import { useSuppressPreview } from '../overlay'

interface Props {
  onClose: () => void
  onCreated: (result: ProjectActionResult) => void
}

const keyOf = (t: { path?: string; name: string }): string => t.path || t.name

export default function NewProjectModal({ onClose, onCreated }: Props): JSX.Element {
  useSuppressPreview()
  const [templates, setTemplates] = useState<TemplateInfo[]>([])
  const [loadingTemplates, setLoadingTemplates] = useState(true)
  const [name, setName] = useState('')
  const [source, setSource] = useState<'builtin' | 'community'>('builtin')
  const [template, setTemplate] = useState('blankapp')

  // Community gallery state
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

  useEffect(() => {
    void window.api.projects
      .templates()
      .then((t) => {
        setTemplates(t)
        if (t.length && !t.some((x) => x.name === 'blankapp')) setTemplate(t[0].name)
      })
      .finally(() => setLoadingTemplates(false))
  }, [])

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
        onCreated(result)
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
    (source === 'builtin'
      ? Boolean(template)
      : customMode
        ? urlValid
        : Boolean(selectedEntry))

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>New Rayfin project</h2>
          <button className="btn btn--sm btn--ghost" onClick={onClose} disabled={busy}>
            ✕
          </button>
        </div>

        <div className="modal-body">
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

        <div className="modal-footer">
          <button className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={create} disabled={busy || !canCreate}>
            {busy ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </div>
    </div>
  )
}
