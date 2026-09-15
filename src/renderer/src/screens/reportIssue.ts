import type { AppVersions, RayfinStudioApi } from '@shared/ipc'
import { formatCopilotCli } from '../copilotVersion'

const REPO_URL = 'https://github.com/spatney/rayfin-fabricator'

/**
 * Build the prefilled GitHub "new issue" URL for a bug report. Environment
 * (versions + user agent) is filled in automatically. When a diagnostics bundle
 * was exported, its path is referenced in the body so the user can drag-and-drop
 * the file onto the issue.
 */
export function buildReportIssueUrl(
  versions: AppVersions | null,
  bundlePath: string | null,
  userAgent: string
): string {
  const body = [
    '### What happened?',
    '',
    '',
    '### Steps to reproduce',
    '',
    '1. ',
    '',
    '### Environment',
    `- App: Fabricator ${versions?.app ?? 'unknown'}`,
    `- Tauri: ${versions?.tauri ?? 'unknown'}`,
    `- WebView2: ${versions?.webview2 ?? 'unknown'}`,
    `- Copilot CLI: ${formatCopilotCli(versions)}`,
    `- User agent: ${userAgent}`,
    ...(bundlePath
      ? [
          '',
          '### Diagnostics',
          `A diagnostics file was saved to \`${bundlePath}\`. Please drag-and-drop it onto this issue to attach it.`
        ]
      : [])
  ].join('\n')
  return `${REPO_URL}/issues/new?labels=bug&title=${encodeURIComponent('[Bug] ')}&body=${encodeURIComponent(body)}`
}

/**
 * Export a diagnostics bundle (best-effort) and open a prefilled GitHub issue in
 * the browser. Diagnostics export must never block the report: if it throws, the
 * issue is still opened (without a bundle reference). Returns the exported bundle
 * path (or `null`) so the caller can hint the user to attach it.
 */
export async function reportIssue(
  api: Pick<RayfinStudioApi, 'diagnostics' | 'openExternal'>,
  versions: AppVersions | null,
  userAgent: string = navigator.userAgent
): Promise<string | null> {
  let bundlePath: string | null = null
  try {
    bundlePath = await api.diagnostics.export()
  } catch {
    /* diagnostics export is best-effort — still open the issue without it */
  }
  void api.openExternal(buildReportIssueUrl(versions, bundlePath, userAgent))
  return bundlePath
}
