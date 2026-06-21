/**
 * Minimal crash/error logging for the main process. Fatal errors that would
 * otherwise vanish (uncaught exceptions, unhandled promise rejections) are
 * appended to a dated file under `userData/logs` so users can find and share
 * them. We deliberately log locally only — nothing is transmitted.
 */

import { app, shell } from 'electron'
import { join } from 'path'
import { appendFileSync, existsSync, mkdirSync } from 'fs'

/** Absolute path to the per-user logs directory (created on demand). */
export function logsDir(): string {
  const dir = join(app.getPath('userData'), 'logs')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function logFile(): string {
  const day = new Date().toISOString().slice(0, 10)
  return join(logsDir(), `main-${day}.log`)
}

/** Append a labelled, timestamped error record; never throws. */
export function logError(label: string, err: unknown): void {
  try {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
    const line = `[${new Date().toISOString()}] ${label}: ${detail}\n`
    appendFileSync(logFile(), line, 'utf8')
    console.error(line.trimEnd())
  } catch {
    /* logging must never crash the app */
  }
}

/** Open the logs folder in the OS file manager. Returns the path. */
export async function openLogs(): Promise<string> {
  const dir = logsDir()
  await shell.openPath(dir)
  return dir
}

/** Register process-level handlers for otherwise-fatal errors. */
export function installCrashHandlers(): void {
  process.on('uncaughtException', (err) => logError('uncaughtException', err))
  process.on('unhandledRejection', (reason) => logError('unhandledRejection', reason))
}
