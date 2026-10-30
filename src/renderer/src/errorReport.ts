/**
 * The single place renderer activity is recorded.
 *
 * Both what worked and what didn't end up in the journal the Help assistant
 * reads. Errors alone are a misleading record: a journal containing nothing but
 * failures makes a healthy app look broken, and a problem the user already
 * solved looks like it is still happening. Pairing each failure with the
 * success that followed is what lets Help say "that worked on the retry"
 * instead of raising an alarm about it.
 *
 * Failures are wired into the places errors already pass through, so call sites
 * don't have to remember:
 *
 *   * {@link ToastProvider} — every `toast.error(...)` call;
 *   * {@link ErrorBoundary} — React render crashes;
 *   * {@link installGlobalErrorCapture} — `window.onerror` and unhandled
 *     promise rejections.
 *
 * Successes have no such chokepoint and are recorded deliberately with
 * {@link reportEvent} at the milestones that answer "did that work?" — setup
 * finishing, signing in, installing a tool, publishing, previewing, opening a
 * project.
 *
 * Recording is best-effort and never throws: an error here would be an error
 * about an error, and the user already has the one they came for.
 */
import type { ActivityLevel, ErrorArea, ErrorReport, ErrorSurface } from '@shared/ipc'

/** Longest detail we send; the backend clips too, but this saves the IPC hop. */
const MAX_DETAIL = 4000

/**
 * The project the user is working in, kept here so error reports can be
 * attributed without threading a project id through every component. Set by the
 * workbench when the active project changes.
 */
let activeProjectId: string | undefined

export function setErrorProject(projectId: string | undefined): void {
  activeProjectId = projectId
}

/**
 * Guess which part of the app an error came from, from the operation name and
 * the message. Call sites can always pass an explicit area; this keeps the
 * common path free of ceremony and is only ever used for grouping.
 */
export function inferArea(operation: string | undefined, message: string): ErrorArea {
  const haystack = `${operation ?? ''} ${message}`.toLowerCase()
  if (/\bdeploy|\bpublish|fabric workspace|capacity\b/.test(haystack)) return 'deploy'
  // The app's local backend (rayfin-local) runs what the preview shows; its
  // supervisor journals under the same area.
  if (/local backend|rayfin-local|\blocal_/.test(haystack)) return 'preview'
  if (/\bsign.?in|sign.?out|auth|token|credential|tenant\b/.test(haystack)) return 'auth'
  if (/\bpreview|dev server|port\b/.test(haystack)) return 'preview'
  if (/\bchat|copilot turn|steer\b/.test(haystack)) return 'chat'
  if (/\bteam|workspace member|collaborator\b/.test(haystack)) return 'team'
  if (/\badvisor|review|finding\b/.test(haystack)) return 'advisor'
  if (/\bgit|commit|branch|push|pull\b/.test(haystack)) return 'git'
  if (/\bproject|template|scaffold\b/.test(haystack)) return 'project'
  if (/\bdoctor|install|node|npm\b/.test(haystack)) return 'setup'
  return 'app'
}

/** Pull a readable message out of whatever was thrown or rejected. */
export function errorMessage(reason: unknown, fallback = 'Something went wrong.'): string {
  if (typeof reason === 'string' && reason.trim()) return reason.trim()
  if (reason instanceof Error && reason.message.trim()) return reason.message.trim()
  if (reason && typeof reason === 'object') {
    const message = (reason as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message.trim()
  }
  return fallback
}

/** A stack trace or serialized payload, when there is one worth keeping. */
function errorDetail(reason: unknown): string | undefined {
  if (reason instanceof Error && reason.stack) return reason.stack.slice(0, MAX_DETAIL)
  if (reason && typeof reason === 'object') {
    try {
      const json = JSON.stringify(reason)
      if (json && json !== '{}') return json.slice(0, MAX_DETAIL)
    } catch {
      // Circular or otherwise unserializable: the message alone will do.
    }
  }
  return undefined
}

/**
 * Record one entry. Never throws and never rejects, so callers can fire and
 * forget it from inside a `catch`.
 */
function record(report: Partial<ErrorReport> & { message: string }): void {
  try {
    const message = report.message.trim()
    if (!message) return
    const level = report.level ?? 'error'
    void window.api?.diagnostics
      ?.record({
        level,
        area: report.area ?? inferArea(report.operation, message),
        event: report.event,
        // An `info` entry never reached the user through a surface, so sending
        // one would be a small lie in the record the assistant reads.
        surface: level === 'info' ? undefined : (report.surface ?? 'toast'),
        message: message.slice(0, MAX_DETAIL),
        operation: report.operation,
        detail: report.detail?.slice(0, MAX_DETAIL),
        projectId: report.projectId ?? activeProjectId,
        // A dev build is the developer's own half-finished edits, not a fault
        // in the installed app. Tagged rather than dropped: still useful to
        // whoever is building, but Help must not report it as a user problem.
        dev: import.meta.env.DEV
      })
      .catch(() => {
        // The journal is a diagnostic aid, not a critical path.
      })
  } catch {
    // Ditto — including `window.api` not being there yet during early startup.
  }
}

/**
 * Record one error. Never throws and never rejects, so callers can fire and
 * forget it from inside a `catch`.
 */
export function reportError(report: Partial<ErrorReport> & { message: string }): void {
  record({ ...report, level: report.level ?? 'error' })
}

/**
 * Record something that went right, or something worth knowing that isn't a
 * fault. `event` is a stable dotted name (`deploy.succeeded`, `setup.completed`)
 * so the assistant can match it to an earlier failure of the same thing instead
 * of comparing prose.
 *
 * Keep these to milestones a user would recognise as "that worked". A firehose
 * of routine chatter buries the entries that answer their question.
 */
export function reportEvent(
  area: ErrorArea,
  event: string,
  message: string,
  extra: { level?: ActivityLevel; operation?: string; detail?: string; projectId?: string } = {}
): void {
  record({ ...extra, level: extra.level ?? 'info', area, event, message })
}

/** Record something that was thrown or rejected, deriving message and detail. */
export function reportThrown(
  reason: unknown,
  context: { operation?: string; area?: ErrorArea; surface?: ErrorSurface; fallback?: string } = {}
): string {
  const message = errorMessage(reason, context.fallback)
  reportError({
    message,
    detail: errorDetail(reason),
    operation: context.operation,
    area: context.area,
    surface: context.surface ?? 'inline'
  })
  return message
}

/**
 * Catch the errors that never reach a `catch` block: exceptions that escape to
 * the window, and promise rejections nobody handled. Installed once at startup.
 *
 * Returns a teardown function, used by tests.
 */
export function installGlobalErrorCapture(): () => void {
  const onError = (event: ErrorEvent): void => {
    reportError({
      surface: 'unhandled',
      area: 'ui',
      message: errorMessage(event.error ?? event.message, 'An unexpected error occurred.'),
      detail: errorDetail(event.error) ?? `${event.filename}:${event.lineno}:${event.colno}`,
      operation: 'window.onerror'
    })
  }

  const onRejection = (event: PromiseRejectionEvent): void => {
    reportError({
      surface: 'unhandled',
      area: 'ui',
      message: errorMessage(event.reason, 'A background task failed.'),
      detail: errorDetail(event.reason),
      operation: 'unhandledrejection'
    })
  }

  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  return () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
  }
}
