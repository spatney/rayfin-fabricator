/**
 * Draws a Power BI report's exported PDF as page images and reads each page's
 * text, for a report migration. pdf.js is large, so it's loaded on first use,
 * with its worker bundled: Fabricator runs offline under a CSP that only allows
 * its own workers.
 */

/** A pdf.js text item, as the page text needs it. */
export interface PdfTextItem {
  str: string
  /** pdf.js's transform: [a, b, c, d, x, y], with y measured up from the page's bottom. */
  transform: number[]
  width: number
  height: number
}

/** Text items further apart than this many line heights read as separate visuals. */
const COLUMN_GAP = 4
/** Icon glyphs, such as Power BI's KPI status icons and slicer chevrons, map to the Private Use Area. */
const ICON_GLYPHS = /[\uE000-\uF8FF]/g

/**
 * A page's text as lines, top to bottom and left to right. Words on one line are
 * joined with spaces, and text far apart on the same line (two cards side by
 * side) with " | ".
 */
export function pageText(items: readonly PdfTextItem[]): string {
  const words = items
    .map((item) => ({ item, str: item.str.replace(ICON_GLYPHS, '').trim() }))
    .filter(({ str }) => str !== '')
    .map(({ item, str }) => ({
      str,
      x: item.transform[4] ?? 0,
      y: item.transform[5] ?? 0,
      width: item.width,
      height: Math.max(1, item.height || Math.abs(item.transform[3] ?? 0))
    }))
    .sort((a, b) => b.y - a.y || a.x - b.x)
  const lines: (typeof words)[] = []
  for (const word of words) {
    const line = lines[lines.length - 1]
    const ref = line?.[0]
    if (ref && Math.abs(ref.y - word.y) <= Math.max(1.5, Math.min(ref.height, word.height) * 0.5)) line.push(word)
    else lines.push([word])
  }
  return lines
    .map((line) => {
      const sorted = [...line].sort((a, b) => a.x - b.x)
      let out = ''
      let end = -Infinity
      for (const word of sorted) {
        if (out) out += word.x - end > word.height * COLUMN_GAP ? ' | ' : ' '
        out += word.str
        end = word.x + word.width
      }
      return out
    })
    .join('\n')
}

/** One drawn page. */
export interface DrawnPage {
  /** The page as a PNG data URL. */
  png: string
  /** A small preview, as a PNG data URL. */
  thumb: string
  text: string
}

/** Pages are drawn this many pixels wide: enough to read every label. */
const PAGE_WIDTH = 1600
const THUMB_WIDTH = 176

function thumbOf(canvas: HTMLCanvasElement): string {
  const scale = Math.min(1, THUMB_WIDTH / canvas.width)
  const thumb = document.createElement('canvas')
  thumb.width = Math.max(1, Math.round(canvas.width * scale))
  thumb.height = Math.max(1, Math.round(canvas.height * scale))
  const ctx = thumb.getContext('2d')
  if (!ctx) return canvas.toDataURL('image/png')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(canvas, 0, 0, thumb.width, thumb.height)
  return thumb.toDataURL('image/png')
}

async function loadPdfjs(): Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const worker = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  return pdfjs
}

/** How many pages `data` (a PDF) has. pdf.js takes over the buffer, so pass one you don't need again. */
export async function countPdfPages(data: ArrayBuffer): Promise<number> {
  const pdfjs = await loadPdfjs()
  const task = pdfjs.getDocument({ data: new Uint8Array(data) })
  try {
    return (await task.promise).numPages
  } finally {
    await task.destroy()
  }
}

/**
 * Draw every page of `data` (a PDF) on a white background and read its text,
 * handing each page to `onPage` as soon as it's ready. Returns the page count.
 * Stops early, without an error, when `cancelled()` turns true.
 */
export async function drawPdfPages(
  data: ArrayBuffer,
  onPage: (page: DrawnPage, index: number, total: number) => Promise<void>,
  cancelled: () => boolean = () => false
): Promise<number> {
  const pdfjs = await loadPdfjs()
  const task = pdfjs.getDocument({ data: new Uint8Array(data) })
  const doc = await task.promise
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      if (cancelled()) break
      const page = await doc.getPage(n)
      const base = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: PAGE_WIDTH / base.width })
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(viewport.width)
      canvas.height = Math.round(viewport.height)
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Could not draw the page: no canvas.')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvas, canvasContext: ctx, viewport }).promise
      const content = await page.getTextContent()
      const items = content.items.flatMap((item): PdfTextItem[] =>
        'str' in item ? [{ str: item.str, transform: item.transform, width: item.width, height: item.height }] : []
      )
      await onPage({ png: canvas.toDataURL('image/png'), thumb: thumbOf(canvas), text: pageText(items) }, n - 1, doc.numPages)
      page.cleanup()
    }
    return doc.numPages
  } finally {
    await task.destroy()
  }
}
