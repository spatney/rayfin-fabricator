import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from '../../i18n'
import { useModalFocus } from '../../modalFocus'
import { useSuppressPreview } from '../../overlay'
import { isMac, modKey } from '../../platform'
import { Codicon } from '../icons'
import { loadImage } from './images'
import {
  EMPTY_HISTORY,
  MARK_COLORS,
  MARK_TOOLS,
  TOOL_WIDTH,
  commit,
  constrain,
  flatten,
  isVisible,
  paintMarks,
  redo,
  undo,
  type Mark,
  type MarkHistory,
  type MarkTool,
  type Point
} from './markup'
import './imageView.css'

/** Small pictures (an element's crop) grow up to this much, so they're easy to draw on. */
const MAX_GROW = 2
/** Space kept around the picture inside its stage, in CSS pixels. */
const INSET = 20
/** A second Escape within this long discards a drawing. */
const DISCARD_MS = 2500

const TOOL_ICONS: Record<MarkTool, JSX.Element> = {
  pen: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 20l1.2-4.6L16.6 4a2 2 0 0 1 2.8 0l.6.6a2 2 0 0 1 0 2.8L8.6 18.8z" />
      <path d="M14.5 6.1l3.4 3.4" />
    </svg>
  ),
  highlighter: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 14l-3 3v3h3l3-3" />
      <path d="M9 14l7.6-9.4a2 2 0 0 1 3 .2l.6.6a2 2 0 0 1 .2 3L12 17z" />
      <path d="M4 21h7" />
    </svg>
  ),
  arrow: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 19L19 5" />
      <path d="M10 5h9v9" />
    </svg>
  ),
  box: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="5" width="16" height="14" rx="3" />
    </svg>
  )
}

/** A cursor that shows where a pen or highlighter will draw, in its color and size. */
function inkCursor(tool: MarkTool, color: string): string {
  if (tool !== 'pen' && tool !== 'highlighter') return 'crosshair'
  const size = Math.max(8, Math.min(24, TOOL_WIDTH[tool]))
  const box = size + 6
  const c = box / 2
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${box}" height="${box}">` +
    `<circle cx="${c}" cy="${c}" r="${size / 2}" fill="${color}" fill-opacity="${tool === 'highlighter' ? 0.5 : 1}" stroke="rgba(0,0,0,0.55)" stroke-width="1.5"/>` +
    `<circle cx="${c}" cy="${c}" r="${size / 2 + 1.5}" fill="none" stroke="rgba(255,255,255,0.8)" stroke-width="1"/>` +
    '</svg>'
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${c} ${c}, crosshair`
}

interface Props {
  /** The picture, shown at once. */
  src: string
  /** The full-size picture when `src` is a smaller copy; drawing waits for it. */
  loadFull?: () => Promise<string>
  /** What it is ("Screenshot", "Button · Save"), for its title. */
  label: string
  /** Finished: the picture with the drawing on it (a PNG data URL), or null when nothing was drawn. */
  onDone: (drawn: string | null) => void
  onCancel: () => void
}

/**
 * See a picture large and draw on it, to show Copilot what you mean: a pen, a
 * highlighter, arrows and boxes, in a few colors that read on any screen.
 * Marks are drawn in the picture's own pixels and saved at its full size.
 */
export function ImageMarkup({ src, loadFull, label, onDone, onCancel }: Props): JSX.Element {
  const { t } = useTranslation('chat')
  useSuppressPreview()
  const dialogRef = useModalFocus<HTMLDivElement>()
  const titleId = useId()
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [image, setImage] = useState<{ url: string; el: HTMLImageElement } | null>(null)
  const [failed, setFailed] = useState(false)
  const [room, setRoom] = useState<{ w: number; h: number } | null>(null)
  const [tool, setToolState] = useState<MarkTool>('pen')
  const [color, setColorState] = useState(MARK_COLORS[0].value)
  // The pointer reads these, so a stroke started right after a key press uses the new choice.
  const toolRef = useRef(tool)
  const colorRef = useRef(color)
  const setTool = (next: MarkTool): void => {
    toolRef.current = next
    setToolState(next)
  }
  const setColor = (next: string): void => {
    colorRef.current = next
    setColorState(next)
  }
  const [history, setHistory] = useState<MarkHistory>(EMPTY_HISTORY)
  const [drawing, setDrawing] = useState(false)
  /** Escape was pressed once with a drawing: a second one discards it. */
  const [discarding, setDiscardingState] = useState(false)
  const discardingRef = useRef(false)
  const setDiscarding = (armed: boolean): void => {
    discardingRef.current = armed
    setDiscardingState(armed)
  }
  const draft = useRef<{ mark: Mark; origin: Point } | null>(null)
  const frame = useRef(0)
  const mac = isMac()
  const mod = modKey()

  // The full-size picture, falling back to the copy we were given.
  const loadRef = useRef(loadFull)
  loadRef.current = loadFull
  useEffect(() => {
    let alive = true
    const open = async (): Promise<void> => {
      const urls = [src]
      try {
        const full = await loadRef.current?.()
        if (full) urls.unshift(full)
      } catch {
        // The copy will do.
      }
      for (const url of urls) {
        try {
          const el = await loadImage(url)
          if (alive) setImage({ url, el })
          return
        } catch {
          // Try the next.
        }
      }
      if (alive) setFailed(true)
    }
    void open()
    return () => {
      alive = false
    }
  }, [src])

  // The room the picture has: it's fitted into it, and follows the window.
  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const measure = (): void =>
      setRoom({
        w: Math.max(0, stage.clientWidth - INSET * 2),
        h: Math.max(0, stage.clientHeight - INSET * 2)
      })
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  const natural = image ? { w: image.el.naturalWidth || 1, h: image.el.naturalHeight || 1 } : null
  const fit = natural && room ? Math.min(room.w / natural.w, room.h / natural.h, MAX_GROW) : 1
  const shown = natural
    ? { w: Math.max(1, Math.round(natural.w * fit)), h: Math.max(1, Math.round(natural.h * fit)) }
    : null
  /** Image pixels per CSS pixel, as the picture is shown. */
  const unit = natural && shown ? natural.w / shown.w : 1

  const shownW = shown?.w ?? 0
  const shownH = shown?.h ?? 0
  const naturalW = natural?.w ?? 0
  const paint = useCallback((): void => {
    const canvas = canvasRef.current
    if (!canvas || !shownW || !naturalW) return
    const zoom = Number(document.documentElement.style.zoom) || 1
    const dpr = (window.devicePixelRatio || 1) * zoom
    const width = Math.round(shownW * dpr)
    const height = Math.round(shownH * dpr)
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, width, height)
    const scale = width / naturalW
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    const marks = draft.current ? [...history.present, draft.current.mark] : history.present
    paintMarks(ctx, marks, dpr)
  }, [history.present, shownW, shownH, naturalW])
  const paintRef = useRef(paint)
  paintRef.current = paint
  useEffect(() => paint(), [paint])
  useEffect(() => () => cancelAnimationFrame(frame.current), [])
  const schedule = (): void => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      paintRef.current()
    })
  }

  const toImage = (event: { clientX: number; clientY: number }): Point => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const w = natural?.w ?? 1
    const h = natural?.h ?? 1
    return [
      ((event.clientX - rect.left) / (rect.width || 1)) * w,
      ((event.clientY - rect.top) / (rect.height || 1)) * h
    ]
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (event.button !== 0 || !natural) return
    event.preventDefault()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Not every pointer can be captured; the drag still draws while it's over the picture.
    }
    const point = toImage(event)
    const kind = toolRef.current
    const freehand = kind === 'pen' || kind === 'highlighter'
    draft.current = {
      origin: point,
      mark: {
        tool: kind,
        color: colorRef.current,
        width: TOOL_WIDTH[kind] * unit,
        points: freehand ? [point] : [point, point]
      }
    }
    setDiscarding(false)
    setDrawing(true)
    schedule()
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const current = draft.current
    if (!current) return
    const { mark, origin } = current
    if (mark.tool === 'pen' || mark.tool === 'highlighter') {
      const native = event.nativeEvent
      const moves = native.getCoalescedEvents?.() ?? []
      for (const move of moves.length > 0 ? moves : [native]) {
        const point = toImage(move)
        const last = mark.points[mark.points.length - 1]
        if (Math.hypot(point[0] - last[0], point[1] - last[1]) >= unit * 0.75)
          mark.points.push(point)
      }
    } else {
      const point = toImage(event)
      mark.points = [origin, event.shiftKey ? constrain(mark.tool, origin, point) : point]
    }
    schedule()
  }
  const onPointerUp = (): void => {
    const current = draft.current
    draft.current = null
    setDrawing(false)
    if (current && isVisible(current.mark))
      setHistory((h) => commit(h, [...h.present, current.mark]))
    else schedule()
  }

  const finish = (): void => {
    if (!image || !natural || history.present.length === 0) {
      onDone(null)
      return
    }
    let drawn: string | null
    try {
      drawn = flatten(image.el, natural.w, natural.h, history.present, unit)
    } catch {
      drawn = null
    }
    onDone(drawn)
  }
  const finishRef = useRef(finish)
  finishRef.current = finish
  const cancelRef = useRef(onCancel)
  cancelRef.current = onCancel
  const marked = history.present.length > 0
  const markedRef = useRef(marked)
  markedRef.current = marked

  useEffect(() => {
    if (!discarding) return
    const timer = window.setTimeout(() => {
      discardingRef.current = false
      setDiscardingState(false)
    }, DISCARD_MS)
    return () => window.clearTimeout(timer)
  }, [discarding])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const withMod = mac ? event.metaKey : event.ctrlKey
      if (event.key === 'Escape') {
        event.preventDefault()
        // One Escape doesn't throw a drawing away: it asks for a second.
        if (discardingRef.current || !markedRef.current) cancelRef.current()
        else {
          discardingRef.current = true
          setDiscardingState(true)
        }
        return
      }
      if (withMod && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        setHistory((h) => (event.shiftKey ? redo(h) : undo(h)))
        return
      }
      if (withMod && !mac && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        setHistory(redo)
        return
      }
      // Enter on a focused button presses it; anywhere else it finishes.
      if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
        event.preventDefault()
        finishRef.current()
        return
      }
      if (withMod || event.altKey || event.repeat) return
      const pick = MARK_TOOLS.find((t) => t.key.toLowerCase() === event.key.toLowerCase())
      if (pick) {
        setTool(pick.id)
        return
      }
      const n = Number(event.key)
      if (Number.isInteger(n) && n >= 1 && n <= MARK_COLORS.length)
        setColor(MARK_COLORS[n - 1].value)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mac])

  return createPortal(
    <div className="modal-backdrop markup">
      <div
        className="markup-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
      >
        <header className="markup-head">
          <div className="markup-title">
            <h2 id={titleId}>{label}</h2>
            <p>{t('imageMarkup.hint')}</p>
          </div>
          <button
            type="button"
            className="markup-icon-btn"
            onClick={onCancel}
            aria-label={t('actions.cancel')}
            title={t('imageMarkup.cancelTitle')}
          >
            <Codicon name="close" />
          </button>
        </header>
        <div className="markup-stage" ref={stageRef}>
          {failed ? (
            <p className="markup-note">{t('imageMarkup.failed')}</p>
          ) : image && shown ? (
            <div className="markup-sheet" style={{ width: shown.w, height: shown.h }}>
              <img src={image.url} alt={label} draggable={false} />
              <canvas
                ref={canvasRef}
                className={`markup-ink${drawing ? ' markup-ink--drawing' : ''}`}
                style={{ cursor: inkCursor(tool, color) }}
                aria-label={t(`imageMarkup.area.${tool}`)}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              />
            </div>
          ) : (
            <span className="markup-note" role="status">
              <span className="step-spin" aria-hidden="true" />
              {t('imageMarkup.opening')}
            </span>
          )}
          {discarding && (
            <p className="markup-toast" role="status">
              {t('imageMarkup.discard')}
            </p>
          )}
        </div>
        <div className="markup-tools" role="toolbar" aria-label={t('imageMarkup.tools')}>
          <div className="markup-group" role="group" aria-label={t('imageMarkup.tool')}>
            {MARK_TOOLS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`markup-icon-btn markup-tool${tool === item.id ? ' is-on' : ''}`}
                aria-pressed={tool === item.id}
                aria-label={item.label}
                title={t('imageMarkup.withKey', { label: item.label, key: item.key })}
                onClick={() => setTool(item.id)}
              >
                {TOOL_ICONS[item.id]}
              </button>
            ))}
          </div>
          <span className="markup-sep" aria-hidden="true" />
          <div className="markup-group" role="group" aria-label={t('imageMarkup.color')}>
            {MARK_COLORS.map((c, i) => (
              <button
                key={c.value}
                type="button"
                className={`markup-swatch${color === c.value ? ' is-on' : ''}`}
                style={{ '--swatch': c.value } as CSSProperties}
                aria-pressed={color === c.value}
                aria-label={c.label}
                title={t('imageMarkup.withKey', { label: c.label, key: i + 1 })}
                onClick={() => setColor(c.value)}
              />
            ))}
          </div>
          <span className="markup-sep" aria-hidden="true" />
          <div className="markup-group">
            <button
              type="button"
              className="markup-icon-btn"
              onClick={() => setHistory(undo)}
              disabled={history.past.length === 0}
              aria-label={t('actions.undo')}
              title={t('imageMarkup.undoTitle', { mod })}
            >
              <Codicon name="discard" />
            </button>
            <button
              type="button"
              className="markup-icon-btn"
              onClick={() => setHistory(redo)}
              disabled={history.future.length === 0}
              aria-label={t('imageMarkup.redo')}
              title={t('imageMarkup.redoTitle', { mod })}
            >
              <Codicon name="redo" />
            </button>
            <button
              type="button"
              className="markup-icon-btn"
              onClick={() => setHistory((h) => commit(h, []))}
              disabled={!marked}
              aria-label={t('imageMarkup.clear')}
              title={t('imageMarkup.clear')}
            >
              <Codicon name="trash" />
            </button>
          </div>
          <span className="markup-spacer" />
          <button type="button" className="btn btn--ghost" onClick={onCancel}>
            {t('actions.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={finish}
            title={marked ? t('imageMarkup.keepTitle') : t('imageMarkup.closeTitle')}
            autoFocus
          >
            {t('actions.done')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
