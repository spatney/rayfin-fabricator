import type { AppIconImage } from '@shared/ipc'
import { hueOf } from './components/team/map/parts'

/** The sizes an app's icon is drawn at (px), as `ICON_SIZES` in `commands/export.rs` takes them. */
export const APP_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256] as const

/** The colour of an app's tile when it has no icon of its own. */
export function tileColor(name: string): string {
  return `hsl(${hueOf(name)} 55% 46%)`
}

/** The letter on an app's tile. */
export function initialOf(name: string): string {
  return name.trim()[0]?.toUpperCase() ?? '?'
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('The icon couldn’t be read.'))
    image.src = src
  })
}

/** A square with rounded corners (`roundRect` is missing from older macOS web views). */
function roundedSquare(ctx: CanvasRenderingContext2D, size: number, radius: number): void {
  ctx.beginPath()
  ctx.moveTo(radius, 0)
  ctx.arcTo(size, 0, size, size, radius)
  ctx.arcTo(size, size, 0, size, radius)
  ctx.arcTo(0, size, 0, 0, radius)
  ctx.arcTo(0, 0, size, 0, radius)
  ctx.closePath()
}

function drawTile(ctx: CanvasRenderingContext2D, size: number, name: string): void {
  roundedSquare(ctx, size, size * 0.22)
  ctx.fillStyle = tileColor(name)
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.font = `600 ${Math.round(size * 0.56)}px "Segoe UI", system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(initialOf(name), size / 2, size / 2 + size * 0.03)
}

/** The image, as large as fits, in the middle. A drawing without a size of its own fills it. */
function drawImage(ctx: CanvasRenderingContext2D, size: number, image: HTMLImageElement): void {
  const width = image.naturalWidth || size
  const height = image.naturalHeight || size
  const scale = Math.min(size / width, size / height)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(
    image,
    (size - width * scale) / 2,
    (size - height * scale) / 2,
    width * scale,
    height * scale
  )
}

function draw(size: number, paint: (ctx: CanvasRenderingContext2D) => void): string {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Fabricator couldn’t draw the app’s icon.')
  paint(ctx)
  const url = canvas.toDataURL('image/png')
  return url.slice(url.indexOf(',') + 1)
}

/**
 * The app's icon at each of {@link APP_ICON_SIZES}, as PNGs: the icon its page
 * names (`source`, a `data:` URL), else a tile in its colour with its initial.
 */
export async function drawAppIcon(
  source: string | undefined,
  name: string
): Promise<AppIconImage[]> {
  const image = source ? await loadImage(source).catch(() => null) : null
  return APP_ICON_SIZES.map((size) => {
    if (image) {
      try {
        return { size, png: draw(size, (ctx) => drawImage(ctx, size, image)) }
      } catch {
        // A picture the page may not read back: the tile instead.
      }
    }
    return { size, png: draw(size, (ctx) => drawTile(ctx, size, name)) }
  })
}
