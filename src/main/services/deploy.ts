/**
 * Deploy engine: Studio owns the deploy loop (the chat agent edits code only).
 *
 * Flow (verified against rayfin 1.22):
 *  - Run `npx rayfin up -y` in human mode (the project's pinned CLI, not a global
 *    rayfin), streaming progress to the UI. `--json` suppresses progress, and slow
 *    deploys need visible feedback, so we stream the human output and capture it.
 *  - After a successful deploy, run `npx rayfin up status --json` for the canonical
 *    record (`deployment.rayfinApiUrl`, `fabricPortalUrl`). We also scrape the
 *    deploy stdout for the static `Hosting URL:` (only emitted at deploy time).
 *  - Preview URL priority: hostingUrl → rayfinApiUrl → fabricPortalUrl.
 *  - On success we commit the project as a deploy checkpoint so the
 *    "changed since last deploy" (git-dirty) signal stays meaningful.
 */

import { run } from './exec'
import { findProject, updateDeploy, updateProject } from './store'
import type {
  DeployOutcome,
  DeployResult,
  DeployStatus,
  DryRunResult,
  FabricDeployment
} from '../../shared/ipc'

type StreamFn = (stream: 'stdout' | 'stderr' | 'system', chunk: string) => void

const DEPLOY_TIMEOUT_MS = 20 * 60_000

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Map a user-supplied workspace target to the right `rayfin up` flag:
 *  - a Fabric portal URL  → `--workspace-uri <url>`
 *  - a bare GUID          → `--workspace-id <id>`
 *  - anything else        → `-w <display name>`
 */
function workspaceArgs(workspace: string | undefined): string[] {
  const w = workspace?.trim()
  if (!w) return []
  if (/^https?:\/\//i.test(w)) return ['--workspace-uri', w]
  if (GUID_RE.test(w)) return ['--workspace-id', w]
  return ['-w', w]
}

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

  const res = await run('npx', ['rayfin', 'up', 'status', '--json'], {
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
export async function runDeploy(
  projectId: string,
  onData?: StreamFn,
  workspace?: string,
  force = false
): Promise<DeployResult> {
  const project = findProject(projectId)
  if (!project) return { ok: false, outcome: 'not-found', error: 'Project not found.' }

  // Explicit target wins; otherwise reuse the workspace the user picked before.
  const workspaceTarget = (workspace ?? project.workspace)?.trim() || undefined
  if (workspace && workspace.trim()) {
    updateProject(projectId, { workspace: workspace.trim() })
  }

  updateDeploy(projectId, { status: 'deploying', outcome: undefined, at: new Date().toISOString() })
  onData?.('system', `Deploying ${project.name} to Fabric…\n`)

  const upArgs = ['up', '-y', ...(force ? ['--force'] : []), ...workspaceArgs(workspaceTarget)]
  let captured = ''
  // Use the project's pinned CLI (devDependency) via npx, not a global rayfin.
  const result = await run('npx', ['rayfin', ...upArgs], {
    cwd: project.path,
    timeout: DEPLOY_TIMEOUT_MS,
    onData: (stream, chunk) => {
      captured += chunk
      onData?.(stream, chunk)
    }
  })

  if (result.notFound) {
    const error = 'The rayfin CLI was not found on PATH.'
    updateDeploy(projectId, { status: 'error', outcome: 'not-found', error, at: new Date().toISOString() })
    return { ok: false, outcome: 'not-found', error }
  }

  if (!result.ok) {
    const lower = (captured + result.stderr).toLowerCase()
    const notSignedIn = /not (logged|signed) in|login|unauthor|authenticate/.test(lower)
    const needsForce = !force && lower.includes('destructive')
    const needsWorkspace = /no workspace targeting context|pass --workspace/.test(lower)
    const outcome: DeployOutcome = notSignedIn
      ? 'not-signed-in'
      : needsForce
        ? 'needs-force'
        : needsWorkspace
          ? 'needs-workspace'
          : 'error'
    const error =
      (result.stderr.trim() || captured.trim().split(/\r?\n/).slice(-3).join(' ')).slice(0, 500) ||
      `rayfin up exited with code ${result.exitCode ?? 'unknown'}.`
    updateDeploy(projectId, { status: 'error', outcome, error, at: new Date().toISOString() })
    onData?.(
      'system',
      outcome === 'needs-workspace'
        ? '\nThis project has no Fabric workspace yet — choose one to deploy into.\n'
        : outcome === 'needs-force'
          ? '\nThis deploy needs --force to apply destructive schema changes (possible data loss).\n'
          : `\nDeploy failed: ${error}\n`
    )
    return { ok: false, outcome, error }
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
    outcome: 'success',
    error: undefined,
    at: new Date().toISOString()
  })

  await commitCheckpoint(project.path, `Deploy ${project.name} (${new Date().toISOString()})`)
  onData?.('system', `\n✅ Deployed. ${url ? `Live at ${url}` : ''}\n`)

  return { ok: true, outcome: 'success', url, apiUrl, portalUrl }
}

/**
 * Preview a deploy with `rayfin up --dry-run` — reports the operations that
 * *would* run without touching Fabric. Streams output and never throws.
 */
export async function dryRunDeploy(
  projectId: string,
  onData?: StreamFn,
  workspace?: string
): Promise<DryRunResult> {
  const project = findProject(projectId)
  if (!project) return { ok: false, output: '', error: 'Project not found.' }

  const workspaceTarget = (workspace ?? project.workspace)?.trim() || undefined
  onData?.('system', `Previewing deploy for ${project.name} (dry run — no changes)…\n`)

  let captured = ''
  const result = await run('npx', ['rayfin', 'up', '-n', ...workspaceArgs(workspaceTarget)], {
    cwd: project.path,
    timeout: DEPLOY_TIMEOUT_MS,
    onData: (stream, chunk) => {
      captured += chunk
      onData?.(stream, chunk)
    }
  })

  if (result.notFound) {
    return { ok: false, output: captured, error: 'The rayfin CLI was not found on PATH.' }
  }
  if (!result.ok) {
    const error =
      (result.stderr.trim() || captured.trim().split(/\r?\n/).slice(-3).join(' ')).slice(0, 500) ||
      `rayfin up --dry-run exited with code ${result.exitCode ?? 'unknown'}.`
    onData?.('system', `\nDry run failed: ${error}\n`)
    return { ok: false, output: captured, error }
  }

  onData?.('system', '\n✅ Dry run complete — no changes were made.\n')
  return { ok: true, output: captured }
}

interface RawDeployment {
  workspaceName?: string
  active?: boolean
  workspaceId?: string
  itemId?: string
  apiUrl?: string
  hostingUrl?: string
  deployedAt?: string
}

/** List the Fabric deployments recorded for a project (`rayfin up list --json`). */
export async function listDeployments(projectId: string): Promise<FabricDeployment[]> {
  const project = findProject(projectId)
  if (!project) return []
  const res = await run('npx', ['rayfin', 'up', 'list', '--json'], {
    cwd: project.path,
    timeout: 60_000
  })
  if (!res.ok) return []
  // `up list --json` prints a single compact JSON array; grab the last line
  // that parses as an array (defensive against any preceding noise).
  const lines = res.stdout.split(/\r?\n/).filter((l) => l.trim())
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as RawDeployment[]
      if (Array.isArray(parsed)) {
        return parsed.map((d) => ({
          workspaceName: d.workspaceName ?? '(unknown)',
          active: Boolean(d.active),
          workspaceId: d.workspaceId,
          itemId: d.itemId,
          apiUrl: d.apiUrl,
          hostingUrl: d.hostingUrl,
          deployedAt: d.deployedAt
        }))
      }
    } catch {
      /* not JSON — keep scanning upward */
    }
  }
  return []
}

/**
 * Switch the active Fabric deployment (`rayfin up switch`). Rewrites the
 * project's `rayfin/.env`, then refreshes the recorded URL so the preview
 * follows the newly active workspace.
 */
export async function switchDeployment(
  projectId: string,
  workspace: string,
  byId = false
): Promise<DeployResult> {
  const project = findProject(projectId)
  if (!project) return { ok: false, outcome: 'not-found', error: 'Project not found.' }

  const args = byId ? ['rayfin', 'up', 'switch', '--workspace-id', workspace] : ['rayfin', 'up', 'switch', workspace]
  const res = await run('npx', args, { cwd: project.path, timeout: 120_000 })
  if (res.notFound) {
    return { ok: false, outcome: 'not-found', error: 'The rayfin CLI was not found on PATH.' }
  }
  if (!res.ok) {
    const error =
      (res.stderr.trim() || res.stdout.trim().split(/\r?\n/).slice(-3).join(' ')).slice(0, 500) ||
      'rayfin up switch failed.'
    return { ok: false, outcome: 'error', error }
  }

  const status = await getDeployStatus(projectId)
  const url = pickPreviewUrl(undefined, status.apiUrl, status.portalUrl)
  updateProject(projectId, { workspace })
  updateDeploy(projectId, {
    url,
    apiUrl: status.apiUrl,
    portalUrl: status.portalUrl,
    status: status.deployed ? 'success' : undefined,
    outcome: status.deployed ? 'success' : undefined,
    error: undefined,
    at: new Date().toISOString()
  })
  return { ok: true, outcome: 'success', url, apiUrl: status.apiUrl, portalUrl: status.portalUrl }
}
