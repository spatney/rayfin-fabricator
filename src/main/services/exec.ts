/**
 * Cross-platform process runner.
 *
 * Wraps `execa` (loaded lazily via dynamic import because execa v9 is ESM-only
 * while the Electron main process is bundled as CommonJS). execa correctly
 * resolves Windows `.cmd` shims (npm, rayfin, copilot, git) without going through
 * a shell, so we avoid shell-quoting pitfalls.
 */

import type { ResultPromise } from 'execa'

type ExecaFn = (file: string, args?: readonly string[], options?: Record<string, unknown>) => ResultPromise

let execaPromise: Promise<ExecaFn> | null = null

async function getExeca(): Promise<ExecaFn> {
  if (!execaPromise) {
    execaPromise = import('execa').then((m) => m.execa as unknown as ExecaFn)
  }
  return execaPromise
}

export interface RunResult {
  ok: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  /** True when the executable could not be found on PATH. */
  notFound: boolean
}

export interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Called with each chunk of output for streaming UIs. */
  onData?: (stream: 'stdout' | 'stderr', chunk: string) => void
  /** Hard timeout in milliseconds. */
  timeout?: number
}

/**
 * Run a command to completion, capturing (and optionally streaming) output.
 * Never rejects: failures are reported via the returned RunResult.
 */
export async function run(file: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  let execa: ExecaFn
  try {
    execa = await getExeca()
  } catch (err) {
    return { ok: false, exitCode: null, stdout: '', stderr: String(err), notFound: false }
  }

  const subprocess = execa(file, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    reject: false,
    timeout: opts.timeout,
    all: false,
    stripFinalNewline: false,
    windowsHide: true
  }) as ResultPromise & {
    stdout?: NodeJS.ReadableStream | null
    stderr?: NodeJS.ReadableStream | null
  }

  if (opts.onData) {
    subprocess.stdout?.on('data', (d: Buffer) => opts.onData?.('stdout', d.toString()))
    subprocess.stderr?.on('data', (d: Buffer) => opts.onData?.('stderr', d.toString()))
  }

  const result = (await subprocess) as {
    exitCode?: number
    stdout?: string
    stderr?: string
    failed?: boolean
    code?: string
  }

  const notFound = result.code === 'ENOENT'
  const exitCode = typeof result.exitCode === 'number' ? result.exitCode : null

  return {
    ok: exitCode === 0 && !notFound,
    exitCode,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    notFound
  }
}

/** Convenience helper that returns trimmed stdout, or null if the command failed. */
export async function tryVersion(file: string, args: string[] = ['--version']): Promise<string | null> {
  const res = await run(file, args, { timeout: 15_000 })
  if (!res.ok) return null
  const out = (res.stdout || res.stderr).trim()
  return out.length ? out : null
}
