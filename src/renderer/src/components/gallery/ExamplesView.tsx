import { useCallback, useEffect, useState, type JSX } from 'react'
import type { CommunityGallery, CommunityTemplate } from '@shared/ipc'
import { Trans, translator, useTranslation } from '../../i18n'
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
  const { t } = useTranslation('gallery')
  const [gallery, setGallery] = useState<CommunityGallery | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    const failed = (): string => translator('gallery')('examples.loadFailed')
    try {
      const result = await window.api.projects.communityTemplates()
      if (result.ok && result.gallery) setGallery(result.gallery)
      else setError(result.error ?? failed())
    } catch {
      setError(failed())
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
        <span className="gallery-note-text">{t('examples.loading')}</span>
      </p>
    )
  }
  if (error || !gallery) {
    return (
      <div className="gallery-state" role="alert">
        <Codicon name="warning" className="gallery-state-glyph" />
        <p className="gallery-state-title">{t('examples.failedTitle')}</p>
        <p className="gallery-state-sub">{error}</p>
        <div className="gallery-state-actions">
          <button type="button" className="btn" onClick={() => void load()}>
            {t('actions.tryAgain')}
          </button>
        </div>
      </div>
    )
  }
  if (gallery.templates.length === 0) {
    return (
      <div className="gallery-state">
        <Codicon name="beaker" className="gallery-state-glyph" />
        <p className="gallery-state-title">{t('examples.empty')}</p>
      </div>
    )
  }
  const source = gallery.displayName || gallery.repoUrl.replace(/^https:\/\/github\.com\//, '')
  return (
    <>
      <p className="gallery-note">
        <Codicon name="info" />
        <span className="gallery-note-text">
          <Trans
            t={t}
            i18nKey="examples.intro"
            values={{ source }}
            components={{ b: <strong /> }}
          />
        </span>
      </p>
      <ul className="gallery-grid" aria-label={t('examples.label')}>
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
                    aria-label={t('examples.useLabel', { name: template.name })}
                    onClick={() => onUse(template)}
                  >
                    {t('examples.use')}
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
