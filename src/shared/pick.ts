/**
 * Touch Up wire protocol.
 *
 * The renderer talks to the in-preview agent
 * (`src-tauri/src/services/pick_agent.js`) through the Rust host, which only
 * relays these JSON documents (`preview_pick_*` commands). The agent reports
 * what the user does in the page as events; the renderer keeps the picks, per
 * project, and sends them with the next chat message.
 */

/** Fabricator's own theme, pushed so the highlight in the page matches the app. */
export interface PickHostTheme {
  accent: string
  panel: string
  panel2?: string
  border?: string
  txt: string
  txtDim?: string
  /** UI zoom (1 = 100%). */
  scale?: number
}

/** Friendly element category, used for labels. */
export type PickRole =
  | 'button'
  | 'link'
  | 'heading'
  | 'text'
  | 'image'
  | 'icon'
  | 'field'
  | 'card'
  | 'list'
  | 'item'
  | 'table'
  | 'chart'
  | 'nav'
  | 'header'
  | 'footer'
  | 'section'
  | 'container'
  | 'element'

/** A picked element, with what Copilot needs to find it in the source and change it. */
export interface PickTarget {
  /** Friendly label, e.g. "Button · Add deal". */
  label: string
  role: PickRole
  tag: string
  /** Best-effort CSS path in the live DOM. */
  selector: string
  /** Route (path + query + hash) it was picked on. */
  route: string
  /** Size when picked, in CSS px. */
  box: { w: number; h: number }
  /** Visible text (trimmed and clipped). */
  text?: string
  /** The full `class` attribute. */
  classes?: string
  /** React component name, when the build exposes one. */
  component?: string
  ariaLabel?: string
  nearestHeading?: string
  /** Enclosing landmark (header / nav / main / aside / footer / section). */
  region?: string
  /** Graphein chart details when the element is a chart. */
  chart?: { type?: string; title?: string }
  /** `data-*` attributes (excluding the Graphein spec), capped. */
  dataAttrs?: Record<string, string>
  /** The computed styles that say how it looks, without browser defaults. */
  styles?: Record<string, string>
  /** A compact copy of its HTML. */
  html?: string
}

export interface PickRect {
  x: number
  y: number
  w: number
  h: number
}

/** Something the user did in the page, in order (`seq`). */
export type PickEvent =
  /** Picking came on from the page (its shortcut). */
  | { seq: number; type: 'enter' }
  /** Picking went off from the page (Escape, Done or the shortcut). */
  | { seq: number; type: 'exit' }
  | {
      seq: number
      type: 'pick'
      pick: { id: string; n: number; target: PickTarget; rect: PickRect | null }
    }
  /** A picked element was clicked again. */
  | { seq: number; type: 'unpick'; id: string }
  /** Shift+drag: a region of the app was clipped, for a screenshot. */
  | { seq: number; type: 'capture'; capture: { id: string; label: string; rect: PickRect | null } }

export interface PickViewport {
  w: number
  h: number
  dpr: number
}

export interface PickStatus {
  v: number
  /** This page load; `null` from the Fabric relay until the app frame answers. */
  page: string | null
  armed: boolean
  on: boolean
  /** The latest event's `seq`. */
  seq: number
  /** The events after the `since` the host asked with (all of them on a new page). */
  events: PickEvent[]
  /** Results of data-returning commands, keyed by their `requestId`. */
  results: Record<string, unknown>
  route: string
  viewport: PickViewport
}

/** Where each element sits in the captured frame (`prepareCapture`). */
export interface PickCaptureLayout {
  viewport: PickViewport
  /** Offset of the app frame inside the captured surface, or `null` when it
   *  can't be known (then nothing can be cropped). */
  frame: { x: number; y: number } | null
  /** Visible part of each element, in app-viewport CSS px. */
  rects: Record<string, PickRect>
}

/** One of the host's picks, as the page outlines and numbers it. */
export interface PickRef {
  id: string
  n: number
  /** Finds it again after the page reloads. */
  selector?: string
  route?: string
}

/** What `preview.pick.set` hands the page besides armed and on. */
export interface PickSetOptions {
  theme?: PickHostTheme
  picks?: PickRef[]
}

export type PickCommand =
  /** Hide the highlight and report where each element sits, for a screenshot. */
  | { op: 'prepareCapture'; requestId: string; ids: string[] }
  /** Show the highlight again; `flash` flashes the clip just captured. */
  | { op: 'endCapture'; flash?: string }
  /** Outline a pick (a chip in the composer is hovered); `null` stops. */
  | { op: 'focus'; id: string | null }
  | { op: 'sync'; picks: PickRef[] }
  | { op: 'toggle' }
  | { op: 'exit' }

/** An element to look up in the project's source (`pick.locate`). */
export interface PickLocateTarget {
  key: string
  tag?: string
  classes?: string
  text?: string
  chartTitle?: string
  chartType?: string
}

export interface PickLocateCandidate {
  /** Project-relative path with forward slashes. */
  file: string
  /** 1-based line number. */
  line: number
  reason: string
  /** 0..1 confidence. */
  score: number
  snippet: string
}

export interface PickLocateResult {
  /** The Tailwind entry stylesheet (the file importing `tailwindcss`). */
  entryCss?: string
  targets: { key: string; candidates: PickLocateCandidate[] }[]
}
