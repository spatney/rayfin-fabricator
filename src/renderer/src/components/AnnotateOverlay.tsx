import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react'
import { useSuppressPreview } from '../overlay'
import type { PendingShot } from './PreviewPane'

/** A freehand stroke, stored in canvas-pixel coordinates so it survives redraws. */
interface Stroke {
  color: string
  /** Line width in canvas pixels (already scaled for the displayed zoom). */
  width: number
  points: { x: number; y: number }[]
}

/** Annotation pen colours (kept few — chips are clearer than a full picker). */
const COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#ffffff', '#1c1c1e']

/** Stroke presets, expressed in *displayed* pixels (scaled to canvas at draw time). */
const WIDTHS: { id: string; label: string; px: number }[] = [
  { id: 's', label: 'S', px: 3 },
  { id: 'm', label: 'M', px: 6 },
  { id: 'l', label: 'L', px: 11 }
]

interface Props {
  /** PNG `data:` URL of the frozen preview to annotate. */
  image: string
  /** Discard the annotation and return to the live preview. */
  onCancel: () => void
  /** Persist the composited PNG and stage it as a chat attachment. */
  onConfirm: (shot: PendingShot) => void
}

/**
 * Full-window overlay that lets the user draw on a frozen screenshot of the
 * preview and stage the result as a chat attachment.
 *
 * The live preview is a native WebView2 child surface that paints above all HTML,
 * so we cannot annotate it in place. Instead the caller captures it to a PNG and
 * mounts this overlay, which {@link useSuppressPreview suppresses} (hides) the
 * native webview and renders the captured image into a `<canvas>` the user can
 * draw on. On confirm we composite image + strokes to a PNG, save it to a temp
 * file via `screenshot.save`, and hand the path back through {@link Props.onConfirm}.
 */
export default function AnnotateOverlay({ image, onCancel, onConfirm }: Props): JSX.Element {
  // Hide the native preview webview while the overlay is up (it would paint over us).
  useSuppressPreview(true)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const strokesRef = useRef<Stroke[]>([])
  const drawingRef = useRef<Stroke | null>(null)

  const [color, setColor] = useState(COLORS[0])
  const [widthPx, setWidthPx] = useState(WIDTHS[1].px)
  const [ready, setReady] = useState(false)
  const [hasStrokes, setHasStrokes] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Repaint the whole canvas: base image, then every committed/in-flight stroke.
  const redraw = useCallback((): void => {
    const canvas = canvasRef.current
    const img = imgRef.current
    if (!canvas || !img) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const all = drawingRef.current
      ? [...strokesRef.current, drawingRef.current]
      : strokesRef.current
    for (const stroke of all) drawStroke(ctx, stroke)
  }, [])

  // Load the captured PNG, size the canvas to its natural resolution, paint it.
  useEffect(() => {
    const img = new Image()
    img.onload = () => {
      imgRef.current = img
      const canvas = canvasRef.current
      if (canvas) {
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
      }
      setReady(true)
      redraw()
    }
    img.src = image
  }, [image, redraw])

  // Esc cancels the overlay (mirrors the app's other dismissible surfaces).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  /** Map a pointer event to canvas-pixel coordinates (canvas is CSS-scaled to fit). */
  const toCanvasPoint = (e: PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const sx = canvas.width / rect.width
    const sy = canvas.height / rect.height
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy }
  }

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>): void => {
    if (!ready) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const canvas = canvasRef.current!
    const scale = canvas.width / canvas.getBoundingClientRect().width
    drawingRef.current = {
      color,
      width: Math.max(1, widthPx * scale),
      points: [toCanvasPoint(e)]
    }
    redraw()
  }

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>): void => {
    const stroke = drawingRef.current
    if (!stroke) return
    stroke.points.push(toCanvasPoint(e))
    redraw()
  }

  const finishStroke = (e: PointerEvent<HTMLCanvasElement>): void => {
    const stroke = drawingRef.current
    if (!stroke) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    drawingRef.current = null
    // A click without movement still leaves a visible dot.
    strokesRef.current = [...strokesRef.current, stroke]
    setHasStrokes(true)
    redraw()
  }

  const undo = (): void => {
    strokesRef.current = strokesRef.current.slice(0, -1)
    setHasStrokes(strokesRef.current.length > 0)
    redraw()
  }

  const clear = (): void => {
    strokesRef.current = []
    drawingRef.current = null
    setHasStrokes(false)
    redraw()
  }

  const confirm = useCallback(async (): Promise<void> => {
    const canvas = canvasRef.current
    if (!canvas || saving) return
    setSaving(true)
    setError(null)
    try {
      redraw()
      const dataUrl = canvas.toDataURL('image/png')
      const path = await window.api.screenshot.save(dataUrl)
      const thumb = makeThumb(canvas)
      onConfirm({ path, thumb })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }, [onConfirm, redraw, saving])

  return (
    <div className="annotate" role="dialog" aria-label="Annotate screenshot">
      <div className="annotate-toolbar">
        <span className="annotate-hint">Draw on the screenshot, then attach it to your message.</span>
        <div className="annotate-tools">
          <div className="annotate-colors">
            {COLORS.map((c) => (
              <button
                key={c}
                className={`annotate-swatch${c === color ? ' is-active' : ''}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
                title={`Pen colour ${c}`}
                aria-label={`Pen colour ${c}`}
              />
            ))}
          </div>
          <div className="annotate-widths">
            {WIDTHS.map((w) => (
              <button
                key={w.id}
                className={`annotate-width${w.px === widthPx ? ' is-active' : ''}`}
                onClick={() => setWidthPx(w.px)}
                title={`${w.label} pen`}
              >
                {w.label}
              </button>
            ))}
          </div>
          <button className="btn btn--sm btn--ghost" onClick={undo} disabled={!hasStrokes}>
            Undo
          </button>
          <button className="btn btn--sm btn--ghost" onClick={clear} disabled={!hasStrokes}>
            Clear
          </button>
        </div>
        <div className="annotate-actions">
          {error && <span className="annotate-error">{error}</span>}
          <button className="btn btn--sm btn--ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button className="btn btn--sm btn--primary" onClick={() => void confirm()} disabled={saving}>
            {saving ? 'Attaching…' : 'Attach to chat'}
          </button>
        </div>
      </div>
      <div className="annotate-stage">
        <canvas
          ref={canvasRef}
          className="annotate-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finishStroke}
          onPointerCancel={finishStroke}
        />
      </div>
    </div>
  )
}

/** Stroke the given path onto a 2D context. */
function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
  const pts = stroke.points
  if (pts.length === 0) return
  ctx.strokeStyle = stroke.color
  ctx.fillStyle = stroke.color
  ctx.lineWidth = stroke.width
  if (pts.length === 1) {
    // A single tap → a dot.
    ctx.beginPath()
    ctx.arc(pts[0].x, pts[0].y, stroke.width / 2, 0, Math.PI * 2)
    ctx.fill()
    return
  }
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
  ctx.stroke()
}

/** Downscale the canvas to a small PNG data URL for the chat attachment chip. */
function makeThumb(canvas: HTMLCanvasElement): string {
  const maxW = 176
  const scale = Math.min(1, maxW / canvas.width)
  const tw = Math.max(1, Math.round(canvas.width * scale))
  const th = Math.max(1, Math.round(canvas.height * scale))
  const thumb = document.createElement('canvas')
  thumb.width = tw
  thumb.height = th
  const ctx = thumb.getContext('2d')
  if (!ctx) return canvas.toDataURL('image/png')
  ctx.drawImage(canvas, 0, 0, tw, th)
  return thumb.toDataURL('image/png')
}
