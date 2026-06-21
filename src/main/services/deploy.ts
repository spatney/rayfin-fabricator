/**
 * Deploy engine: Studio owns the deploy loop (the chat agent edits code only).
 *
 * Flow (verified against rayfin 1.22):
 *  - Run `rayfin up -y` in human mode, streaming progress to the UI. `--json`
 *    suppresses progress, and slow deploys need visible feedback, so we stream
 *    the human output and capture it.
 *  - After a successful deploy, run `rayfin up status --json` for the canonical
 *    record (`deployment.rayfinApiUrl`, `fabricPortalUrl`). We also scrape the
 *    deploy stdout for the static `Hosting URL:` (only emitted at deploy time).
 *  - Preview URL priority: hostingUrl → rayfinApiUrl → fabricPortalUrl.
 *  - On success we commit the project as a deploy checkpoint so the
 *    "changed since last deploy" (git-dirty) signal stays meaningful.
 */

import { run } from './exec'
import { findProject, updateDeploy } from './store'
import type { DeployResult, DeployStatus } from '../../shared/ipc'

type StreamFn = (stream: 'stdout' | 'stderr' | 'system', chunk: string) => void

const DEPLOY_TIMEOUT_MS = 20 * 60_000

/** Pull a `Hosting URL:` / `Static Hosting URL:` value out of human deploy output. */
function scrapeHostingUrl(text: string): string | undefined {
  const m = text.match(/Hosting URL:\s*(\S+)/i)
  return m ? m[1].trim() : undefined
}

/** Best URL to load in the preview, in priority order. */
function pickPreviewUrl(
  hostingUrl: string | undefined,
  apiUrl: string | undefined,
  portalUrl: string | undefined
): string | undefined {
  return hostingUrl || apiUrl || portalUrl || undefined
}

interface StatusJson {
  deployed?: boolean
  deployment?: {
    rayfinApiUrl?: string | null
    fabricPortalUrl?: string | null
  }
}

/** Parse the (possibly noisy) stdout of `rayfin up status --json`. */
function parseStatusJson(stdout: string): StatusJson | null {
  // The status command prints a single compact JSON object; be defensive and
  // grab the last line that parses as JSON.
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim())
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]) as StatusJson
    } catch {
      /* not JSON — keep scanning upward */
    }
  }
  return null
}

/** Read the persisted deployment status without deploying. */
export async function getDeployStatus(projectId: string): Promise<DeployStatus> {
  const project = findProject(projectId)
  if (!project) return { deployed: false }

  const res = await run('rayfin', ['up', 'status', '--json'], {
    cwd: project.path,
    timeout: 60_000
  })
  const parsed = parseStatusJson(res.stdout)
  if (!parsed || !parsed.deployed) return { deployed: false }

  const apiUrl = parsed.deployment?.rayfinApiUrl ?? undefined
  const portalUrl = parsed.deployment?.fabricPortalUrl ?? undefined
  return { deployed: true, url: pickPreviewUrl(undefined, apiUrl, portalUrl), apiUrl, portalUrl }
}

/** True when the project's git working tree has uncommitted changes. */
export async function hasPendingChanges(projectId: string): Promise<boolean> {
  const project = findProject(projectId)
  if (!project) return false
  const res = await run('git', ['status', '--porcelain'], {
    cwd: project.path,
    timeout: 30_000
  })
  if (!res.ok) return false
  return res.stdout.trim().length > 0
}

/** Commit the current working tree as a deploy checkpoint (best-effort). */
async function commitCheckpoint(dir: string, message: string): Promise<void> {
  const status = await run('git', ['status', '--porcelain'], { cwd: dir, timeout: 30_000 })
  if (!status.ok || !status.stdout.trim()) return
  await run('git', ['add', '-A'], { cwd: dir, timeout: 30_000 })
  await run('git', ['commit', '-m', message], { cwd: dir, timeout: 30_000 })
}

/**
 * Run a full `rayfin up` for the project and resolve the live URL.
 * Never throws — failures are reported via the returned DeployResult.
 */
export async function runDeploy(projectId: string, onData?: StreamFn): Promise<DeployResult> {
  const project = findProject(projectId)
  if (!project) return { ok: false, outcome: 'not-found', error: 'Project not found.' }

  updateDeploy(projectId, { status: 'deploying', at: new Date().toISOString() })
  onData?.('system', `Deploying ${project.name} to Fabric…\n`)

  let captured = ''
  const result = await run('rayfin', ['up', '-y'], {
    cwd: project.path,
    timeout: DEPLOY_TIMEOUT_MS,
    onData: (stream, chunk) => {
      captured += chunk
      onData?.(stream, chunk)
    }
  })

  if (result.notFound) {
    const error = 'The rayfin CLI was not found on PATH.'
    updateDeploy(projectId, { status: 'error', error, at: new Date().toISOString() })
    return { ok: false, outcome: 'not-found', error }
  }

  if (!result.ok) {
    const lower = (captured + result.stderr).toLowerCase()
    const notSignedIn = /not (logged|signed) in|login|unauthor|authenticate/.test(lower)
    const error =
      (result.stderr.trim() || captured.trim().split(/\r?\n/).slice(-3).join(' ')).slice(0, 500) ||
      `rayfin up exited with code ${result.exitCode ?? 'unknown'}.`
    updateDeploy(projectId, { status: 'error', error, at: new Date().toISOString() })
    onData?.('system', `\nDeploy failed: ${error}\n`)
    return { ok: false, outcome: notSignedIn ? 'not-signed-in' : 'error', error }
  }

  // Success — resolve the canonical URL from status, enrich with scraped hostingUrl.
  const hostingUrl = scrapeHostingUrl(captured)
  const status = await getDeployStatus(projectId)
  const apiUrl = status.apiUrl
  const portalUrl = status.portalUrl
  const url = pickPreviewUrl(hostingUrl, apiUrl, portalUrl)

  updateDeploy(projectId, {
    url,
    apiUrl,
    portalUrl,
    status: 'success',
    error: undefined,
    at: new Date().toISOString()
  })

  await commitCheckpoint(project.path, `Deploy ${project.name} (${new Date().toISOString()})`)
  onData?.('system', `\n✅ Deployed. ${url ? `Live at ${url}` : ''}\n`)

  return { ok: true, outcome: 'success', url, apiUrl, portalUrl }
}
