/**
 * Screenshot store: persists region captures from the preview `<webview>` to
 * temp files so they can be passed to the Copilot CLI as `--attachment <path>`.
 *
 * Captures are written under a single Studio-owned temp subdirectory; cleanup is
 * scoped to that directory so we can only ever delete our own files.
 */

import { app } from 'electron'
import { join, resolve } from 'path'
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs'
import { randomUUID } from 'crypto'

/** Directory that holds all transient preview screenshots. */
function shotsDir(): string {
  return join(app.getPath('temp'), 'rayfin-studio-shots')
}

/** Decode a PNG data URL and write it to a temp file; returns the absolute path. */
export function saveScreenshot(dataUrl: string): string {
  const match = /^data:image\/png;base64,(.+)$/s.exec(dataUrl ?? '')
  if (!match) throw new Error('Expected a base64 PNG data URL.')
  const dir = shotsDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const file = join(dir, `shot-${randomUUID()}.png`)
  writeFileSync(file, Buffer.from(match[1], 'base64'))
  return file
}

/** Best-effort delete of temp screenshot files (only those inside shotsDir). */
export function cleanupScreenshots(paths: string[]): void {
  const dir = resolve(shotsDir())
  for (const p of paths) {
    try {
      if (resolve(p).startsWith(dir) && existsSync(p)) unlinkSync(p)
    } catch {
      /* best-effort */
    }
  }
}
