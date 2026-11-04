import { useCallback, useEffect, useState, type JSX } from 'react'
import type { CommunityGallery, CommunityTemplate } from '@shared/ipc'
import { Codicon } from '../icons'
import { AppCover } from './AppCard'

/** An example's key in New project: its folder in the gallery's repository, or its name. */
export function exampleKey(template: Pick<CommunityTemplate, 'path' | 'name'>): string {
  return template.path || template.name
}

/**
 * The gallery's Examples: the community apps New project can start from, so
 * the gallery is also where to find what to build. Picking one opens New
 * project with it chosen.
 */
export default function ExamplesView({
  onUse
}: {
  /** Start a new project from this example. */
  onUse: (template: CommunityTemplate) => void
}): JSX.Element {
  const [gallery, setGallery] = useState<CommunityGallery | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const result = await window.api.projects.communityTemplates()
      if (result.ok && result.gallery) setGallery(result.gallery)
      else setError(result.error ?? 'Couldn’t load the examples.')
    } catch {
      setError('Couldn’t load the examples.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (loading && !gallery) {
    return (
      <p className="gallery-note" role="status">
        <Codicon name="loading" className="icon-spin" />
        <span className="gallery-note-text">Loading the examples…</span>
      </p>
    )
  }
  if (error || !gallery) {
    return (
      <div className="gallery-state" role="alert">
        <Codicon name="warning" className="gallery-state-glyph" />
        <p className="gallery-state-title">Couldn’t load the examples</p>
        <p className="gallery-state-sub">{error}</p>
        <div className="gallery-state-actions">
          <button type="button" className="btn" onClick={() => void load()}>
            Try again
          </button>
        </div>
      </div>
    )
  }
  if (gallery.templates.length === 0) {
    return (
      <div className="gallery-state">
        <Codicon name="beaker" className="gallery-state-glyph" />
        <p className="gallery-state-title">No examples yet</p>
      </div>
    )
  }
  const source = gallery.displayName || gallery.repoUrl.replace(/^https:\/\/github\.com\//, '')
  return (
    <>
      <p className="gallery-note">
        <Codicon name="info" />
        <span className="gallery-note-text">
          Apps to start from, from <strong>{source}</strong>. Pick one, and Copilot changes it into
          your app from there.
        </span>
      </p>
      <ul className="gallery-grid" aria-label="Examples">
        {gallery.templates.map((template) => (
          <li key={exampleKey(template)} className="gcard-item">
            <div className="gcard gcard--example">
              <AppCover name={template.name} />
              <span className="gcard-body">
                <span className="gcard-name" title={template.name}>
                  {template.name}
                </span>
                {template.description && <span className="gcard-desc">{template.description}</span>}
                <span className="gcard-meta">
                  <button
                    type="button"
                    className="btn btn--sm btn--primary"
                    aria-label={`Use ${template.name}`}
                    onClick={() => onUse(template)}
                  >
                    Use this example
                  </button>
                </span>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </>
  )
}
