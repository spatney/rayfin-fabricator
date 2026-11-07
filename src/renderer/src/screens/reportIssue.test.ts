import { describe, expect, it, vi } from 'vitest'
import type { AppVersions } from '@shared/ipc'
import { buildReportIssueUrl, reportIssue } from './reportIssue'

const versions: AppVersions = {
  app: '1.2.3',
  tauri: '2.0.0',
  webview2: '120.0.0',
  copilot: '1.0.0',
  rayfinLocal: '0.2.8'
}

/** Decode the `body=` query param of a GitHub new-issue URL. */
function bodyOf(url: string): string {
  const body = new URL(url).searchParams.get('body') ?? ''
  return body
}

describe('buildReportIssueUrl', () => {
  it('targets the rayfin-fabricator new-issue endpoint with the bug label', () => {
    const url = buildReportIssueUrl(versions, null, 'UA/1.0')
    expect(url.startsWith('https://github.com/spatney/rayfin-fabricator/issues/new?')).toBe(true)
    expect(url).toContain('labels=bug')
  })

  it('fills in the environment (versions + user agent)', () => {
    const body = bodyOf(buildReportIssueUrl(versions, null, 'UA/1.0'))
    expect(body).toContain('App: Fabricator 1.2.3')
    expect(body).toContain('Tauri: 2.0.0')
    expect(body).toContain('WebView2: 120.0.0')
    expect(body).toContain('Copilot CLI: 1.0.0')
    expect(body).toContain('rayfin-local: 0.2.8')
    expect(body).toContain('User agent: UA/1.0')
  })

  it('references the diagnostics bundle path when one was exported', () => {
    const body = bodyOf(buildReportIssueUrl(versions, 'C:/logs/fabricator-diagnostics-42.md', 'UA/1.0'))
    expect(body).toContain('## Diagnostics')
    expect(body).toContain('C:/logs/fabricator-diagnostics-42.md')
  })

  it('omits the Diagnostics section when no bundle was exported', () => {
    const body = bodyOf(buildReportIssueUrl(versions, null, 'UA/1.0'))
    expect(body).not.toContain('## Diagnostics')
  })

  it('degrades to "unknown" when versions are unavailable', () => {
    const body = bodyOf(buildReportIssueUrl(null, null, 'UA/1.0'))
    expect(body).toContain('App: Fabricator unknown')
    expect(body).toContain('Copilot CLI: unknown')
    expect(body).toContain('rayfin-local: unknown')
  })

  it('prefixes a drafted bug the way the repository template does', () => {
    const url = new URL(
      buildReportIssueUrl(versions, null, 'UA/1.0', {
        kind: 'bug',
        title: "Deploy fails with 'Tenant not authorized'",
        body: '## Summary\n\nIt broke.'
      })
    )
    expect(url.searchParams.get('title')).toBe("Bug: Deploy fails with 'Tenant not authorized'")
    expect(url.searchParams.get('labels')).toBe('bug')
    expect(url.searchParams.get('body')).toContain('It broke.')
  })

  it('keeps the empty bug template when nothing was drafted', () => {
    const url = new URL(buildReportIssueUrl(versions, null, 'UA/1.0'))
    expect(url.searchParams.get('title')).toBe('Bug: ')
    expect(url.searchParams.get('body')).toContain('Steps to reproduce')
  })
})

describe('reportIssue', () => {
  it('exports diagnostics, opens the issue, and returns the bundle path', async () => {
    const api = {
      diagnostics: { export: vi.fn().mockResolvedValue('C:/logs/bundle.md') },
      openExternal: vi.fn().mockResolvedValue(undefined)
    }

    const bundlePath = await reportIssue(api, versions, 'UA/1.0')

    expect(bundlePath).toBe('C:/logs/bundle.md')
    expect(api.diagnostics.export).toHaveBeenCalledTimes(1)
    expect(api.openExternal).toHaveBeenCalledTimes(1)
    const url = api.openExternal.mock.calls[0][0] as string
    expect(bodyOf(url)).toContain('C:/logs/bundle.md')
  })

  it('still opens the issue when diagnostics export fails (never blocks the report)', async () => {
    const api = {
      diagnostics: { export: vi.fn().mockRejectedValue(new Error('disk full')) },
      openExternal: vi.fn().mockResolvedValue(undefined)
    }

    const bundlePath = await reportIssue(api, versions, 'UA/1.0')

    expect(bundlePath).toBeNull()
    expect(api.openExternal).toHaveBeenCalledTimes(1)
    const url = api.openExternal.mock.calls[0][0] as string
    expect(url).toContain('/issues/new?')
    expect(bodyOf(url)).not.toContain('## Diagnostics')
  })

  it('files a feature request as an enhancement, with no Bug prefix', async () => {
    const api = {
      diagnostics: { export: vi.fn().mockResolvedValue('C:/logs/bundle.md') },
      openExternal: vi.fn().mockResolvedValue(undefined)
    }

    const bundlePath = await reportIssue(api, versions, 'UA/1.0', {
      kind: 'feature',
      title: 'Let me rename a deployment after creating it',
      body: '## Problem or motivation\n\nI named it wrong.'
    })

    // Nothing to diagnose about a feature, so no export and nothing to attach.
    expect(api.diagnostics.export).not.toHaveBeenCalled()
    expect(bundlePath).toBeNull()

    const url = new URL(api.openExternal.mock.calls[0][0] as string)
    expect(url.searchParams.get('labels')).toBe('enhancement')
    expect(url.searchParams.get('title')).toBe('Let me rename a deployment after creating it')
    const body = url.searchParams.get('body') ?? ''
    expect(body).toContain('Problem or motivation')
    expect(body).not.toContain('Steps to reproduce')
    expect(body).not.toContain('App: Fabricator')
  })
})
