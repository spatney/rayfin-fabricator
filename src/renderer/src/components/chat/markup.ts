/**
 * Drawing on a screenshot. Marks are kept in the image's own pixels, so they
 * can be shown at any size and saved at the image's full size.
 */

import { translator } from '../../i18n'

export type MarkTool = 'pen' | 'highlighter' | 'arrow' | 'box'

export type Point = [x: number, y: number]

export interface Mark {
  tool: MarkTool
  color: string
  /** Line width, in image pixels. */
  width: number
  /** In image pixels: the path a pen or highlighter took, or an arrow's or box's two ends. */
  points: Point[]
}

// Each `label` is read when it's shown, in the interface's language.
export const MARK_TOOLS: { id: MarkTool; label: string; key: string }[] = [
  {
    id: 'pen',
    get label() {
      return translator('chat')('markup.pen')
    },
    key: 'P'
  },
  {
    id: 'highlighter',
    get label() {
      return translator('chat')('markup.highlighter')
    },
    key: 'H'
  },
  {
    id: 'arrow',
    get label() {
      return translator('chat')('markup.arrow')
    },
    key: 'A'
  },
  {
    id: 'box',
    get label() {
      return translator('chat')('markup.box')
    },
    key: 'B'
  }
]

export const MARK_COLORS: { label: string; value: string }[] = [
  {
    get label() {
      return translator('chat')('markup.red')
    },
    value: '#ff3b30'
  },
  {
    get label() {
      return translator('chat')('markup.yellow')
    },
    value: '#ffcc00'
  },
  {
    get label() {
      return translator('chat')('markup.green')
    },
    value: '#2fd158'
  },
  {
    get label() {
      return translator('chat')('markup.blue')
    },
    value: '#2f8cff'
  },
  {
    get label() {
      return translator('chat')('markup.white')
    },
    value: '#ffffff'
  }
]

/** How thick each tool draws, in CSS pixels on screen. */
export const TOOL_WIDTH: Record<MarkTool, number> = { pen: 4, highlighter: 20, arrow: 4, box: 3.5 }

/** An arrow snapped to 45° steps, or a box made square (Shift held). */
export function constrain(tool: MarkTool, from: Point, to: Point): Point {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  if (tool === 'box') {
    const side = Math.max(Math.abs(dx), Math.abs(dy))
    return [from[0] + (dx < 0 ? -side : side), from[1] + (dy < 0 ? -side : side)]
  }
  const step = Math.PI / 4
  const angle = Math.round(Math.atan2(dy, dx) / step) * step
  const length = Math.hypot(dx, dy)
  return [from[0] + Math.cos(angle) * length, from[1] + Math.sin(angle) * length]
}

/** Whether a mark shows something: an arrow or a box needs a drag, not a click. */
export function isVisible(mark: Mark): boolean {
  if (mark.tool === 'pen' || mark.tool === 'highlighter') return mark.points.length > 0
  const [a, b] = [mark.points[0], mark.points[mark.points.length - 1]]
  return Boolean(a && b) && Math.hypot(b[0] - a[0], b[1] - a[1]) >= mark.width * 2
}

/**
 * Draw `marks` on `ctx`, whose units are image pixels. `px` is canvas pixels
 * per CSS pixel: canvas shadows ignore the transform, so they're sized by it.
 */
export function paintMarks(
  ctx: CanvasRenderingContext2D,
  marks: readonly Mark[],
  px: number
): void {
  for (const mark of marks) paintMark(ctx, mark, px)
}

function paintMark(ctx: CanvasRenderingContext2D, mark: Mark, px: number): void {
  const { points } = mark
  if (points.length === 0) return
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = mark.color
  ctx.fillStyle = mark.color
  ctx.lineWidth = mark.width
  if (mark.tool === 'highlighter') {
    ctx.globalAlpha = 0.4
  } else {
    // A soft shadow keeps marks readable on light and dark screens alike.
    ctx.shadowColor = 'rgba(0, 0, 0, 0.4)'
    ctx.shadowBlur = 3 * px
    ctx.shadowOffsetY = px
  }
  const first = points[0]
  const last = points[points.length - 1]
  if (mark.tool === 'arrow') arrow(ctx, first, last, mark.width)
  else if (mark.tool === 'box') box(ctx, first, last, mark.width)
  else path(ctx, points)
  ctx.restore()
}

/** A smooth line through the points (a dot for a single one). */
function path(ctx: CanvasRenderingContext2D, points: readonly Point[]): void {
  const [x0, y0] = points[0]
  ctx.beginPath()
  if (points.length === 1) {
    ctx.arc(x0, y0, ctx.lineWidth / 2, 0, Math.PI * 2)
    ctx.fill()
    return
  }
  ctx.moveTo(x0, y0)
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i]
    const [nx, ny] = points[i + 1]
    ctx.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2)
  }
  const [lx, ly] = points[points.length - 1]
  ctx.lineTo(lx, ly)
  ctx.stroke()
}

function arrow(ctx: CanvasRenderingContext2D, from: Point, to: Point, width: number): void {
  const [x1, y1] = from
  const [x2, y2] = to
  const length = Math.hypot(x2 - x1, y2 - y1)
  if (length === 0) return
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const head = Math.min(length * 0.6, width * 4)
  const spread = Math.PI / 7
  // The shaft stops inside the head, so its round end doesn't poke through the tip.
  const shaft = Math.max(0, length - head * 0.7)
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x1 + Math.cos(angle) * shaft, y1 + Math.sin(angle) * shaft)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(x2, y2)
  ctx.lineTo(x2 - head * Math.cos(angle - spread), y2 - head * Math.sin(angle - spread))
  ctx.lineTo(x2 - head * Math.cos(angle + spread), y2 - head * Math.sin(angle + spread))
  ctx.closePath()
  ctx.lineWidth = width / 2
  ctx.fill()
  ctx.stroke()
}

function box(ctx: CanvasRenderingContext2D, a: Point, b: Point, width: number): void {
  const x = Math.min(a[0], b[0])
  const y = Math.min(a[1], b[1])
  const w = Math.abs(b[0] - a[0])
  const h = Math.abs(b[1] - a[1])
  ctx.beginPath()
  if (typeof ctx.roundRect === 'function')
    ctx.roundRect(x, y, w, h, Math.min(width * 2, w / 2, h / 2))
  else ctx.rect(x, y, w, h)
  ctx.stroke()
}

/**
 * The picture with `marks` drawn on it, at its full size, as a PNG data URL.
 * `px` is image pixels per CSS pixel as it was shown, so shadows match.
 */
export function flatten(
  image: CanvasImageSource,
  width: number,
  height: number,
  marks: readonly Mark[],
  px: number
): string {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas is unavailable.')
  ctx.drawImage(image, 0, 0, width, height)
  paintMarks(ctx, marks, px)
  return canvas.toDataURL('image/png')
}

/** Undo history: the marks now, with what came before and what was undone. */
export interface MarkHistory {
  past: Mark[][]
  present: Mark[]
  future: Mark[][]
}

export const EMPTY_HISTORY: MarkHistory = { past: [], present: [], future: [] }

export function commit(history: MarkHistory, present: Mark[]): MarkHistory {
  return { past: [...history.past, history.present], present, future: [] }
}

export function undo(history: MarkHistory): MarkHistory {
  if (history.past.length === 0) return history
  return {
    past: history.past.slice(0, -1),
    present: history.past[history.past.length - 1],
    future: [history.present, ...history.future]
  }
}

export function redo(history: MarkHistory): MarkHistory {
  if (history.future.length === 0) return history
  return {
    past: [...history.past, history.present],
    present: history.future[0],
    future: history.future.slice(1)
  }
}
