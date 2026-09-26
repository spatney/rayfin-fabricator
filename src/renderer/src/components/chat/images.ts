// Image re-encoding for pasted / dropped / picked chat attachments.

/** Largest dimension we keep when re-encoding pasted/added images (keeps temp
 *  files and the model's vision payload reasonable). */
export const MAX_IMAGE_DIM = 2000

export function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read image'))
    reader.readAsDataURL(file)
  })
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not decode image'))
    img.src = src
  })
}

/** Re-encode an image data URL to a (possibly downscaled) PNG plus a small thumb. */
export async function toPngAndThumb(src: string): Promise<{ png: string; thumb: string }> {
  const img = await loadImage(src)
  const fit = Math.min(1, MAX_IMAGE_DIM / Math.max(img.naturalWidth, img.naturalHeight, 1))
  const w = Math.max(1, Math.round(img.naturalWidth * fit))
  const h = Math.max(1, Math.round(img.naturalHeight * fit))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable')
  ctx.drawImage(img, 0, 0, w, h)
  const png = canvas.toDataURL('image/png')

  const tScale = Math.min(1, 176 / w)
  const tw = Math.max(1, Math.round(w * tScale))
  const th = Math.max(1, Math.round(h * tScale))
  const tCanvas = document.createElement('canvas')
  tCanvas.width = tw
  tCanvas.height = th
  const tCtx = tCanvas.getContext('2d')
  if (!tCtx) return { png, thumb: png }
  tCtx.drawImage(canvas, 0, 0, tw, th)
  return { png, thumb: tCanvas.toDataURL('image/png') }
}
