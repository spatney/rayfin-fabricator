import type { PickCaptureLayout, PickRect } from '@shared/pick'

/** A screenshot staged for a chat message (temp PNG path + thumbnail). */
export interface StagedShot {
  path: string
  thumb: string
}

export interface CropBox {
  sx: number
  sy: number
  sw: number
  sh: number
}

/**
 * Where an element's crop sits in a captured preview PNG. `rect` is in the app
 * frame's CSS px; `frame` offsets the app frame inside the captured surface
 * (Fabric-embedded view); the image may be larger than the viewport by the
 * device pixel ratio. A little context (`pad` CSS px) is kept around the element.
 */
export function cropBox(
  rect: PickRect,
  layout: PickCaptureLayout,
  imageWidth: number,
  imageHeight: number,
  pad = 8
): CropBox | null {
  if (!layout.frame || !layout.viewport.w || !imageWidth || !imageHeight) return null
  const scale = imageWidth / layout.viewport.w
  const x = (layout.frame.x + rect.x - pad) * scale
  const y = (layout.frame.y + rect.y - pad) * scale
  const sx = Math.max(0, Math.floor(x))
  const sy = Math.max(0, Math.floor(y))
  const ex = Math.min(imageWidth, Math.ceil((layout.frame.x + rect.x + rect.w + pad) * scale))
  const ey = Math.min(imageHeight, Math.ceil((layout.frame.y + rect.y + rect.h + pad) * scale))
  if (ex - sx < 4 || ey - sy < 4) return null
  return { sx, sy, sw: ex - sx, sh: ey - sy }
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('The preview screenshot could not be decoded.'))
    img.src = dataUrl
  })
}

function draw(img: HTMLImageElement, box: CropBox, maxWidth: number): string {
  const scale = Math.min(1, maxWidth / box.sw)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(box.sw * scale))
  canvas.height = Math.max(1, Math.round(box.sh * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas is unavailable.')
  ctx.drawImage(img, box.sx, box.sy, box.sw, box.sh, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}

/**
 * Cut one crop per item out of a captured preview PNG. Returns crop data URLs
 * keyed by item id (items without a usable rect are skipped).
 */
export async function cropItems(
  dataUrl: string,
  layout: PickCaptureLayout,
  ids: string[],
  maxWidth = 900,
  pad = 8
): Promise<Record<string, string>> {
  const img = await loadImage(dataUrl)
  const out: Record<string, string> = {}
  for (const id of ids) {
    const rect = layout.rects[id]
    const box = rect && cropBox(rect, layout, img.naturalWidth, img.naturalHeight, pad)
    if (box) out[id] = draw(img, box, maxWidth)
  }
  return out
}
