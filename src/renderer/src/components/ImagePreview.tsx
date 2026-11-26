import { useEffect, useRef, useState, type JSX } from 'react'

export interface Size {
  width: number
  height: number
}

/** An image's size in pixels, and how much fitting it to the pane scales it. */
export interface ImageInfo extends Size {
  fit: number
}

/** The least an image's longer side shows at when it's fitted: a smaller one is enlarged. */
const MIN_SIDE = 160

/**
 * How much fitting `natural` to `pane` scales it: a larger image shrinks to fit, and
 * a small one, such as an icon, grows to show its detail, by whole steps unless it's
 * a vector, so its pixels stay square.
 */
export function fitScale(natural: Size, pane: Size, vector: boolean): number {
  const shrink = Math.min(pane.width / natural.width, pane.height / natural.height)
  const side = Math.max(natural.width, natural.height)
  const grow = side >= MIN_SIDE ? 1 : vector ? MIN_SIDE / side : Math.floor(MIN_SIDE / side)
  return Math.min(shrink, grow)
}

/** Whether `scale` changes the image's size at all. */
export const scales = (scale: number): boolean => Math.abs(scale - 1) > 0.005

/**
 * An image file: fitted to the pane, or at its actual size, which scrolls; a click
 * switches between them. A checkerboard shows through its transparent parts.
 */
export function ImagePreview({
  src,
  alt,
  vector,
  full,
  onFull,
  onInfo,
  onError
}: {
  src: string
  alt: string
  /** An SVG: it enlarges smoothly. */
  vector: boolean
  /** At its actual size rather than fitted. */
  full: boolean
  onFull: (full: boolean) => void
  onInfo: (info: ImageInfo) => void
  onError: () => void
}): JSX.Element {
  const paneRef = useRef<HTMLDivElement>(null)
  const [pane, setPane] = useState<Size | null>(null)
  const [natural, setNatural] = useState<Size | null>(null)

  useEffect(() => {
    const el = paneRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) =>
      setPane({ width: entry.contentRect.width, height: entry.contentRect.height })
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const fit =
    natural && pane && pane.width > 0 && pane.height > 0 ? fitScale(natural, pane, vector) : 1
  useEffect(() => {
    if (natural) onInfo({ ...natural, fit })
  }, [natural, fit, onInfo])

  const scale = full ? 1 : fit
  const zoomable = scales(fit)
  // A click shows it larger when it's fitted smaller, or at its actual size larger.
  const larger = full ? fit > 1 : fit < 1
  return (
    <div ref={paneRef} className={`code-image${full ? ' code-image--full' : ''}`}>
      <img
        className={[
          'code-image-img',
          zoomable && (larger ? 'code-image-img--zoom-in' : 'code-image-img--zoom-out'),
          !vector && scale > 1 && 'code-image-img--pixels'
        ]
          .filter(Boolean)
          .join(' ')}
        style={
          natural ? { width: natural.width * scale, height: natural.height * scale } : undefined
        }
        src={src}
        alt={alt}
        draggable={false}
        onLoad={(event) => {
          const img = event.currentTarget
          setNatural(
            img.naturalWidth && img.naturalHeight
              ? { width: img.naturalWidth, height: img.naturalHeight }
              : null
          )
        }}
        onError={onError}
        onClick={zoomable ? () => onFull(!full) : undefined}
      />
    </div>
  )
}
