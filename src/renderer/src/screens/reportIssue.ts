import type { AppVersions, HelpIssueDraft, RayfinStudioApi } from '@shared/ipc'
import { formatCopilotCli } from '../copilotVersion'

const REPO_URL = 'https://github.com/spatney/rayfin-fabricator'

/**
 * Build the prefilled GitHub "new issue" URL. Environment (versions + user
 * agent) is filled in automatically for a bug report; a feature request gets
 * neither, because what version you happen to be on doesn't motivate a feature.
 * When a diagnostics bundle was exported, its path is referenced in the body so
 * the user can drag-and-drop the file onto the issue.
 *
 * When the Help assistant drafted the report, its title and body replace the
 * empty template: it has already read the logs, so the user reviews a filled-in
 * report instead of writing one from memory. Title prefix and label follow the
 * repository's own issue templates (`.github/ISSUE_TEMPLATE`).
 */
export function buildReportIssueUrl(
  versions: AppVersions | null,
  bundlePath: string | null,
  userAgent: string,
  draft?: HelpIssueDraft | null
): string {
  const feature = draft?.kind === 'feature'
  const label = feature ? 'enhancement' : 'bug'
  const drafted = draft?.title?.trim()
  // `bug_report.md` titles start "Bug: "; the feature template has no prefix.
  const title = drafted ? (feature ? drafted : `Bug: ${drafted}`) : 'Bug: '

  const account = draft?.body?.trim()
    ? [draft.body.trim(), '']
    : ['## Summary', '', '', '## Steps to reproduce', '', '1. ', '']

  // A feature request needs no environment block, and nothing to attach.
  const environment = feature
    ? []
    : [
        '## Environment',
        `- App: Fabricator ${versions?.app ?? 'unknown'}`,
        `- Tauri: ${versions?.tauri ?? 'unknown'}`,
        `- WebView2: ${versions?.webview2 ?? 'unknown'}`,
        `- Copilot CLI: ${formatCopilotCli(versions)}`,
        `- rayfin-local: ${versions?.rayfinLocal || 'unknown'}`,
        `- User agent: ${userAgent}`,
        ...(bundlePath
          ? [
              '',
              '## Diagnostics',
              `A diagnostics file was saved to \`${bundlePath}\`. Please drag-and-drop it onto this issue to attach it.`
            ]
          : [])
      ]

  const body = [...account, ...environment].join('\n')
  return `${REPO_URL}/issues/new?labels=${label}&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`
}

/**
 * Export a diagnostics bundle (best-effort) and open a prefilled GitHub issue in
 * the browser. Diagnostics export must never block the report: if it throws, the
 * issue is still opened (without a bundle reference). Returns the exported bundle
 * path (or `null`) so the caller can hint the user to attach it.
 *
 * A feature request skips the export: there is nothing to diagnose.
 */
export async function reportIssue(
  api: Pick<RayfinStudioApi, 'openExternal'> & {
    diagnostics: Pick<RayfinStudioApi['diagnostics'], 'export'>
  },
  versions: AppVersions | null,
  userAgent: string = navigator.userAgent,
  draft?: HelpIssueDraft | null
): Promise<string | null> {
  let bundlePath: string | null = null
  if (draft?.kind !== 'feature') {
    try {
      bundlePath = await api.diagnostics.export()
    } catch {
      /* diagnostics export is best-effort — still open the issue without it */
    }
  }
  void api.openExternal(buildReportIssueUrl(versions, bundlePath, userAgent, draft))
  return bundlePath
}
