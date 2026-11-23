import { useEffect, useRef, useState, type JSX } from 'react'
import type { GalleryApp } from '@shared/ipc'
import { errorMessage } from '../../errorReport'
import { translator, useTranslation } from '../../i18n'
import { topLayerOpen } from '../../overlay'
import { measurePreviewBounds, watchPreviewPixelRatio } from '../../previewBounds'
import { CloseIcon, Codicon } from '../icons'
import { hostOf } from './model'

/**
 * A quick look at an app: its live page in a panel over the gallery, without
 * leaving Fabricator. The page is a native webview kept over the panel's body,
 * which paints above all HTML, so it steps aside while a dialog or Search is
 * open, and goes when the panel closes. Space or Escape closes it.
 */
export default function QuickLook({
  app,
  url,
  onClose,
  onOpenApp,
  onOpenFabric
}: {
  app: GalleryApp
  /** The page to show: the app's own address. */
  url: string
  onClose: () => void
  onOpenApp: () => void
  onOpenFabric: () => void
}): JSX.Element {
  const { t } = useTranslation('gallery')
  const bodyRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [covered, setCovered] = useState(topLayerOpen)

  // The close button takes the focus, so Space closes the look again.
  useEffect(() => closeRef.current?.focus(), [])

  // A dialog or Search over the gallery: the page steps aside for it.
  useEffect(() => {
    const observer = new MutationObserver(() => setCovered(topLayerOpen()))
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const body = bodyRef.current
    if (!body || covered) return
    let live = true
    let shown = false
    const place = (): void => {
      const bounds = live ? measurePreviewBounds(body) : null
      if (!bounds) return
      if (shown) {
        void window.api.gallery.quickLook.setBounds(bounds).catch(() => undefined)
        return
      }
      shown = true
      window.api.gallery.quickLook.show(url, bounds).catch((reason: unknown) => {
        if (live) setFailed(errorMessage(reason, translator('gallery')('quickLook.failed')))
      })
    }
    place()
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
    resize?.observe(body)
    window.addEventListener('resize', place)
    const stopRatio = watchPreviewPixelRatio(place)
    return () => {
      live = false
      resize?.disconnect()
      window.removeEventListener('resize', place)
      stopRatio()
      void window.api.gallery.quickLook.close().catch(() => undefined)
    }
  }, [url, covered])

  return (
    <div
      className="gquick-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="gquick"
        role="dialog"
        aria-modal="true"
        aria-label={t('quickLook.label', { name: app.name })}
      >
        <div className="gquick-bar">
          <span className="gquick-title">
            <span className="gquick-name">{app.name}</span>
            <span className="gquick-host" title={url}>
              {hostOf(url)}
            </span>
          </span>
          <span className="gquick-tools">
            <button type="button" className="btn btn--sm" onClick={onOpenApp}>
              <Codicon name="link-external" />
              {t('app.openApp')}
            </button>
            <button type="button" className="btn btn--sm" onClick={onOpenFabric}>
              <Codicon name="globe" />
              {t('app.openInFabric')}
            </button>
            <button
              ref={closeRef}
              type="button"
              className="icon-btn gquick-close"
              aria-label={t('quickLook.close')}
              title={t('quickLook.closeTitle')}
              onClick={onClose}
            >
              <CloseIcon />
            </button>
          </span>
        </div>
        <div ref={bodyRef} className="gquick-body">
          {failed ? (
            <p className="gquick-note" role="alert">
              {failed}
            </p>
          ) : (
            <p className="gquick-note">{t('quickLook.loading', { name: app.name })}</p>
          )}
        </div>
      </div>
    </div>
  )
}
