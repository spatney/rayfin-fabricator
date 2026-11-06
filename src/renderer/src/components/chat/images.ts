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

/** Re-encode an image data URL to a (possibly downscaled) PNG plus a copy to show
 *  in chat (see {@link viewCopyOf}). */
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
  return { png, thumb: viewCopyOf(canvas, w, h) }
}

/** Longest side of the copy chat keeps of an image: sharp when it's enlarged. */
export const VIEW_IMAGE_DIM = 1280

/**
 * The copy of an image chat shows, in the composer and in the transcript (where
 * it can be enlarged), and keeps with the saved chat: at most
 * {@link VIEW_IMAGE_DIM} on its longest side, as WebP to stay small (JPEG on
 * white where the browser can't encode WebP).
 */
export function viewCopyOf(source: CanvasImageSource, width: number, height: number): string {
  const fit = Math.min(1, VIEW_IMAGE_DIM / Math.max(width, height, 1))
  const w = Math.max(1, Math.round(width * fit))
  const h = Math.max(1, Math.round(height * fit))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, w, h)
  const webp = canvas.toDataURL('image/webp', 0.9)
  if (webp.startsWith('data:image/webp')) return webp
  ctx.globalCompositeOperation = 'destination-over'
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  return canvas.toDataURL('image/jpeg', 0.9)
}

/** {@link viewCopyOf} an image data URL (the image itself when it can't be decoded). */
export async function viewCopy(dataUrl: string): Promise<string> {
  try {
    const img = await loadImage(dataUrl)
    return viewCopyOf(img, img.naturalWidth, img.naturalHeight)
  } catch {
    return dataUrl
  }
}

/** Stage a picture to send: its file for Copilot, and the copy chat shows. */
export async function stageImage(dataUrl: string): Promise<{ path: string; thumb: string }> {
  const [path, thumb] = await Promise.all([window.api.screenshot.save(dataUrl), viewCopy(dataUrl)])
  return { path, thumb }
}
