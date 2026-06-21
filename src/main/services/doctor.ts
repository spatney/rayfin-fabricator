/**
 * Environment doctor: detects the external tools Rayfin Studio depends on and
 * can auto-install the npm-distributed ones (rayfin, copilot).
 */

import { run, tryVersion } from './exec'
import type { DoctorReport, ProcResult, ToolId, ToolStatus } from '../../shared/ipc'

interface ToolDef {
  id: ToolId
  name: string
  bin: string
  versionArgs: string[]
  required: boolean
  /** npm package to install globally, when auto-installable. */
  npmPackage?: string
  installHint: string
  installUrl?: string
}

const TOOLS: ToolDef[] = [
  {
    id: 'node',
    name: 'Node.js',
    bin: 'node',
    versionArgs: ['--version'],
    required: true,
    installHint: 'Install Node.js 18+ (includes npm).',
    installUrl: 'https://nodejs.org/en/download'
  },
  {
    id: 'npm',
    name: 'npm',
    bin: 'npm',
    versionArgs: ['--version'],
    required: true,
    installHint: 'npm ships with Node.js.',
    installUrl: 'https://nodejs.org/en/download'
  },
  {
    id: 'git',
    name: 'Git',
    bin: 'git',
    versionArgs: ['--version'],
    required: true,
    installHint: 'Install Git for version control of your apps.',
    installUrl: 'https://git-scm.com/downloads'
  },
  {
    id: 'rayfin',
    name: 'Rayfin CLI',
    bin: 'rayfin',
    versionArgs: ['--version'],
    required: true,
    npmPackage: '@microsoft/rayfin-cli',
    installHint: 'Scaffolds and deploys Rayfin apps to Microsoft Fabric.',
    installUrl: 'https://aka.ms/rayfin/docs'
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot CLI',
    bin: 'copilot',
    versionArgs: ['--version'],
    required: true,
    npmPackage: '@github/copilot',
    installHint: 'The AI agent that writes and edits your app code.',
    installUrl: 'https://docs.github.com/copilot/how-tos/copilot-cli'
  }
]

const INSTALLABLE: Partial<Record<ToolId, string>> = Object.fromEntries(
  TOOLS.filter((t) => t.npmPackage).map((t) => [t.id, t.npmPackage as string])
)

function parseVersion(raw: string | null): string | null {
  if (!raw) return null
  const m = raw.match(/\d+\.\d+\.\d+(?:[-.][\w.]+)?/)
  return m ? m[0] : raw.trim()
}

async function checkTool(def: ToolDef): Promise<ToolStatus> {
  const raw = await tryVersion(def.bin, def.versionArgs)
  return {
    id: def.id,
    name: def.name,
    found: raw !== null,
    version: parseVersion(raw),
    installHint: def.installHint,
    installUrl: def.installUrl,
    autoInstallable: Boolean(def.npmPackage),
    required: def.required
  }
}

export async function checkEnvironment(): Promise<DoctorReport> {
  const tools = await Promise.all(TOOLS.map(checkTool))
  const ready = tools.filter((t) => t.required).every((t) => t.found)
  return { tools, ready }
}

export async function installTool(
  id: ToolId,
  onData?: (stream: 'stdout' | 'stderr', chunk: string) => void
): Promise<ProcResult> {
  const pkg = INSTALLABLE[id]
  if (!pkg) {
    onData?.('stderr', `Tool "${id}" cannot be installed automatically.\n`)
    return { ok: false, exitCode: null }
  }
  onData?.('stdout', `Installing ${pkg} globally via npm…\n`)
  const res = await run('npm', ['install', '-g', pkg], { onData, timeout: 5 * 60_000 })
  if (res.ok) onData?.('stdout', `\nInstalled ${pkg}.\n`)
  else onData?.('stderr', `\nInstall failed (exit ${res.exitCode}).\n`)
  return { ok: res.ok, exitCode: res.exitCode }
}
