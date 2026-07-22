/**
 * Rasterizes an exported Power BI report PDF (see the Rust
 * `fabric_export_report_pdf` command) into per-page PNG images that the migrate
 * flow stages as chat attachments, so the agent has a pixel-accurate visual
 * reference for each report page in addition to the PBIR definition.
 *
 * Rendering runs in the renderer (WebView2/Chromium) via pdf.js — no native
 * dependency, cross-platform for free — and reuses the existing screenshot
 * attachment plumbing (`window.api.screenshot.save` → {@link PendingShot}).
 */
import type { PendingShot } from './components/PreviewPane'

/** A page's intrinsic size in PDF points (viewport at scale 1). */
export interface PageSize {
  width: number
  height: number
}

/**
 * Power BI's PDF export emits *every* page in the report, including the tiny
 * tooltip and hidden drill-through pages that never appear in the main view.
 * Keep only the "real" pages: those whose area is at least `minAreaRatio` of the
 * largest page. Returns the kept page numbers (1-based, in document order).
 *
 * Falls back to keeping every page when sizes are missing or degenerate, so a
 * surprising export shape never silently drops all pages.
 */
export function pickVisiblePages(sizes: PageSize[], minAreaRatio = 0.25): number[] {
  if (sizes.length === 0) return []
  const areas = sizes.map((s) => Math.max(0, s.width) * Math.max(0, s.height))
  const maxArea = Math.max(...areas)
  if (!(maxArea > 0)) return sizes.map((_, i) => i + 1)
  const kept: number[] = []
  areas.forEach((area, i) => {
    if (area >= maxArea * minAreaRatio) kept.push(i + 1)
  })
  return kept.length > 0 ? kept : sizes.map((_, i) => i + 1)
}

/** Options controlling the rasterized page + thumbnail resolution. */
export interface RenderOptions {
  /** Target rendered page width in pixels (height follows the aspect ratio). */
  maxWidth?: number
  /** Target thumbnail width in pixels (shown in the chat bubble). */
  thumbWidth?: number
}

/** Decode a base64 string (as returned across IPC) into raw bytes for pdf.js. */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** Downscale a rendered page canvas into a small thumbnail data URL. */
function toThumb(source: HTMLCanvasElement, thumbWidth: number): string {
  if (source.width <= thumbWidth) return source.toDataURL('image/png')
  const ratio = thumbWidth / source.width
  const tw = Math.max(1, Math.round(source.width * ratio))
  const th = Math.max(1, Math.round(source.height * ratio))
  const c = document.createElement('canvas')
  c.width = tw
  c.height = th
  const cx = c.getContext('2d')
  if (!cx) return source.toDataURL('image/png')
  cx.drawImage(source, 0, 0, tw, th)
  return c.toDataURL('image/png')
}

let workerConfigured = false

/** Lazily import pdf.js and wire its worker (Vite resolves the URL at build). */
async function loadPdfjs(): Promise<typeof import('pdfjs-dist')> {
  const pdfjs = await import('pdfjs-dist')
  if (!workerConfigured) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url
    ).toString()
    workerConfigured = true
  }
  return pdfjs
}

/**
 * Render every visible page of the given base64 PDF to a PNG, persist each into
 * the project's `source-report/pages/` folder (via `fabric.saveReportPages`), and
 * return the {@link PendingShot}s (path + thumbnail) ready to attach to the
 * migrate chat prompt. Persisting in-project (rather than a temp dir the chat
 * turn engine cleans up) means the build agent can re-open the page images on any
 * later turn as a durable visual reference for theming — not just the first turn.
 * Best-effort: this is a visual aid, so callers should treat a throw as "skip
 * page images", not a fatal error.
 */
export async function renderPdfToShots(
  pdfBase64: string,
  projectPath: string,
  opts: RenderOptions = {}
): Promise<PendingShot[]> {
  const { maxWidth = 1400, thumbWidth = 240 } = opts
  const pdfjs = await loadPdfjs()
  const data = base64ToBytes(pdfBase64)
  const doc = await pdfjs.getDocument({ data }).promise
  try {
    const sizes: PageSize[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const vp = page.getViewport({ scale: 1 })
      sizes.push({ width: vp.width, height: vp.height })
      page.cleanup()
    }
    const keep = pickVisiblePages(sizes)
    const dataUrls: string[] = []
    const thumbs: string[] = []
    for (const pageNum of keep) {
      const page = await doc.getPage(pageNum)
      const base = page.getViewport({ scale: 1 })
      const scale = base.width > 0 ? maxWidth / base.width : 1
      const viewport = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        page.cleanup()
        continue
      }
      await page.render({ canvasContext: ctx, viewport }).promise
      dataUrls.push(canvas.toDataURL('image/png'))
      thumbs.push(toThumb(canvas, thumbWidth))
      page.cleanup()
    }
    if (dataUrls.length === 0) return []
    const paths = await window.api.fabric.saveReportPages(projectPath, dataUrls)
    return paths.map((path, i) => ({ path, thumb: thumbs[i] }))
  } finally {
    await doc.destroy()
  }
}
