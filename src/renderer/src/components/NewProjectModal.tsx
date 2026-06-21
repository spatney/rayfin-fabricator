import { useEffect, useRef, useState } from 'react'
import type { ProjectActionResult, TemplateInfo } from '@shared/ipc'

interface Props {
  onClose: () => void
  onCreated: (result: ProjectActionResult) => void
}

export default function NewProjectModal({ onClose, onCreated }: Props): JSX.Element {
  const [templates, setTemplates] = useState<TemplateInfo[]>([])
  const [name, setName] = useState('')
  const [source, setSource] = useState<'builtin' | 'url'>('builtin')
  const [template, setTemplate] = useState('blankapp')
  const [url, setUrl] = useState('')
  const [templateName, setTemplateName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [log, setLog] = useState('')
  const logRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    void window.api.projects.templates().then((t) => {
      setTemplates(t)
      if (t.length && !t.some((x) => x.name === 'blankapp')) setTemplate(t[0].name)
    })
  }, [])

  useEffect(() => {
    const off = window.api.onProcLog((e) => {
      if (e.channel === 'create:project') setLog((prev) => prev + e.data)
    })
    return off
  }, [])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])

  async function create(): Promise<void> {
    setBusy(true)
    setError(null)
    setLog('')
    try {
      const chosen = source === 'url' ? url.trim() : template
      const result = await window.api.projects.create({
        name,
        template: chosen,
        templateName: source === 'url' ? templateName.trim() || undefined : undefined
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

  const urlValid = source === 'url' ? /^(https?:\/\/|git@|git\+)/i.test(url.trim()) : true
  const canCreate = Boolean(slug) && (source === 'builtin' || urlValid)

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
                className={`seg-btn${source === 'url' ? ' seg-btn--active' : ''}`}
                onClick={() => setSource('url')}
              >
                Community URL
              </button>
            </div>

            {source === 'builtin' ? (
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
            ) : (
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
              </div>
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
