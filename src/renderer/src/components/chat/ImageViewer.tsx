import { useCallback, useEffect, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { useModalFocus } from '../../modalFocus'
import { useSuppressPreview } from '../../overlay'
import { Codicon } from '../icons'
import './imageView.css'

/**
 * A chat image, large. A picture bigger than the window fits it, and a click
 * shows it at full size; the arrow keys step through the rest of the message's
 * pictures.
 */
export function ImageViewer({
  images,
  start = 0,
  onClose
}: {
  images: readonly string[]
  start?: number
  onClose: () => void
}): JSX.Element {
  useSuppressPreview()
  const dialogRef = useModalFocus<HTMLDivElement>()
  const [index, setIndex] = useState(() => Math.min(Math.max(0, start), images.length - 1))
  /** Shown at full size rather than fitted. */
  const [full, setFull] = useState(false)
  /** The picture is shrunk to fit, so it can be shown at full size. */
  const [shrunk, setShrunk] = useState(false)
  const many = images.length > 1

  const step = useCallback(
    (by: number): void => {
      setFull(false)
      setIndex((i) => (i + by + images.length) % images.length)
    },
    [images.length]
  )
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      } else if (many && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault()
        step(event.key === 'ArrowLeft' ? -1 : 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [many, onClose, step])

  return createPortal(
    <div
      className={`modal-backdrop image-viewer${full ? ' image-viewer--full' : ''}`}
      onClick={onClose}
    >
      <div
        className="image-viewer-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={many ? `Picture ${index + 1} of ${images.length}` : 'Picture'}
        tabIndex={-1}
        ref={dialogRef}
      >
        <img
          key={index}
          className={`image-viewer-img${shrunk || full ? ' image-viewer-img--zoomable' : ''}`}
          src={images[index]}
          alt=""
          draggable={false}
          onLoad={(event) => {
            const img = event.currentTarget
            setShrunk(
              img.naturalWidth > img.clientWidth + 1 || img.naturalHeight > img.clientHeight + 1
            )
          }}
          onClick={(event) => {
            event.stopPropagation()
            if (shrunk || full) setFull((f) => !f)
          }}
        />
        <button
          type="button"
          className="image-viewer-btn image-viewer-close"
          onClick={(event) => {
            event.stopPropagation()
            onClose()
          }}
          aria-label="Close"
          title="Close (Esc)"
        >
          <Codicon name="close" />
        </button>
        {many && (
          <>
            <button
              type="button"
              className="image-viewer-btn image-viewer-prev"
              onClick={(event) => {
                event.stopPropagation()
                step(-1)
              }}
              aria-label="Previous picture"
              title="Previous (←)"
            >
              <Codicon name="chevron-left" />
            </button>
            <button
              type="button"
              className="image-viewer-btn image-viewer-next"
              onClick={(event) => {
                event.stopPropagation()
                step(1)
              }}
              aria-label="Next picture"
              title="Next (→)"
            >
              <Codicon name="chevron-right" />
            </button>
            <span className="image-viewer-count" aria-hidden="true">
              {index + 1} / {images.length}
            </span>
          </>
        )}
      </div>
    </div>,
    document.body
  )
}

/**
 * Pictures in the transcript, small: clicking one shows it large. `indexes`
 * picks which of `images` the strip shows (the rest show elsewhere in the
 * message, as picked elements); the viewer steps through all of them.
 */
export function ShotStrip({
  images,
  indexes,
  onOpen
}: {
  images: readonly string[]
  indexes?: readonly number[]
  onOpen: (index: number) => void
}): JSX.Element | null {
  const shown = indexes ?? images.map((_, i) => i)
  if (shown.length === 0) return null
  return (
    <div className="msg-shots">
      {shown.map((i) => (
        <button
          key={i}
          type="button"
          className="msg-shot-open"
          onClick={() => onOpen(i)}
          title="Show it larger"
        >
          <img className="msg-shot" src={images[i]} alt="Screenshot attachment" draggable={false} />
        </button>
      ))}
    </div>
  )
}

/** The picture a transcript block shows large, and a way to show one. */
export function useImageViewer(images: readonly string[] | undefined): {
  open: (index: number) => void
  viewer: JSX.Element | null
} {
  const [shown, setShown] = useState<number | null>(null)
  const close = useCallback(() => setShown(null), [])
  return {
    open: setShown,
    viewer:
      shown != null && images && images.length > 0 ? (
        <ImageViewer images={images} start={shown} onClose={close} />
      ) : null
  }
}
