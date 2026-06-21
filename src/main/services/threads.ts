/**
 * Experimental "side threads": parallel forks of a project that background
 * Copilot agents work in isolation. Each thread is a git branch checked out in
 * a **linked worktree** (kept outside the project dir, under Electron's
 * userData) so two agents never touch the same files. A thread shares the main
 * project's `node_modules` via a directory junction so the agent can still
 * typecheck/build, and carries its own Copilot session id + chat transcript.
 *
 * Lifecycle: create → (agent works in the worktree) → merge into the project's
 * main branch (Copilot resolves conflicts) → worktree + branch are removed. See
 * {@link mergeThread} in merge.ts for the merge half.
 */

import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, rmdirSync, rmSync, symlinkSync } from 'fs'
import { randomUUID } from 'crypto'
import { run } from './exec'
import { findProject, updateProject } from './store'
import { clearHistory } from './history'
import type { CreateThreadInput, ProjectThread, ThreadActionResult } from '../../shared/ipc'

/** Identity used for Fabricator's own commits (matches deploys / history). */
export const COMMIT_IDENT = [
  '-c',
  'user.name=Rayfin Fabricator',
  '-c',
  'user.email=fabricator@rayfin.local'
]

/** Run git in a directory, returning ok + trimmed-ish output. Never throws. */
export async function git(
  cwd: string,
  args: string[]
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const res = await run('git', ['-c', 'core.quotepath=false', ...args], { cwd, timeout: 60_000 })
  return { ok: res.ok, stdout: res.stdout, stderr: res.stderr }
}

/** Root folder holding a project's side-thread worktrees (outside the project). */
function threadsRoot(projectId: string): string {
  return join(app.getPath('userData'), 'worktrees', projectId)
}

/** Absolute path to one thread's linked worktree. */
function worktreePathFor(projectId: string, threadId: string): string {
  return join(threadsRoot(projectId), threadId)
}

/** Confirm a directory is the top of a git work tree. */
async function isRepo(cwd: string): Promise<boolean> {
  const res = await git(cwd, ['rev-parse', '--is-inside-work-tree'])
  return res.ok && res.stdout.trim() === 'true'
}

/** The branch the project's main worktree is currently on (null if detached). */
async function currentBranch(cwd: string): Promise<string | null> {
  const res = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const name = res.ok ? res.stdout.trim() : ''
  return name && name !== 'HEAD' ? name : null
}

/** Commit any pending work in the project's main worktree (best-effort). */
async function commitPending(cwd: string, message: string): Promise<void> {
  const status = await git(cwd, ['status', '--porcelain'])
  if (!status.ok || !status.stdout.trim()) return
  await git(cwd, ['add', '-A'])
  await git(cwd, [...COMMIT_IDENT, 'commit', '-m', message])
}

/** Replace a project's persisted side-thread list and return it. */
function persistThreads(projectId: string, threads: ProjectThread[]): ProjectThread[] {
  updateProject(projectId, { threads })
  return threads
}

/** Share the main project's node_modules into a worktree via a junction. */
function linkNodeModules(projectPath: string, worktreePath: string): void {
  const source = join(projectPath, 'node_modules')
  const target = join(worktreePath, 'node_modules')
  if (!existsSync(source) || existsSync(target)) return
  try {
    symlinkSync(source, target, 'junction')
  } catch {
    /* non-fatal: the agent can still run, just without prebuilt deps */
  }
}

/** Remove a worktree's node_modules junction without touching the real folder. */
function unlinkNodeModules(worktreePath: string): void {
  const target = join(worktreePath, 'node_modules')
  if (!existsSync(target)) return
  try {
    // rmdir removes the junction reparse point itself; it never recurses into
    // (and so never deletes) the linked target. Do this BEFORE any recursive
    // delete of the worktree so we can't follow the link into main's deps.
    rmdirSync(target)
  } catch {
    /* best-effort */
  }
}

/** List a project's side threads. */
export function listThreads(projectId: string): ProjectThread[] {
  return findProject(projectId)?.threads ?? []
}

/** Look up one side thread. */
export function getThread(projectId: string, threadId: string): ProjectThread | undefined {
  return findProject(projectId)?.threads?.find((t) => t.id === threadId)
}

/**
 * Fork a new side thread: a branch + linked worktree + its own Copilot session.
 * The fork is based on the project's main branch HEAD (pending work is committed
 * first so the thread starts from a complete base).
 */
export async function createThread(input: CreateThreadInput): Promise<ThreadActionResult> {
  const project = findProject(input.projectId)
  const existing = project?.threads ?? []
  if (!project) return { ok: false, error: 'Project not found.', threads: existing }

  const name = input.name.trim() || 'Side thread'
  const cwd = project.path

  if (!(await isRepo(cwd))) {
    return { ok: false, error: 'This project isn’t tracked by git, so it can’t be forked.', threads: existing }
  }

  const baseBranch = await currentBranch(cwd)
  if (!baseBranch) {
    return { ok: false, error: 'The project is in a detached git state; switch to a branch first.', threads: existing }
  }

  await commitPending(cwd, `Checkpoint before forking side thread: ${name}`)
  const headRes = await git(cwd, ['rev-parse', 'HEAD'])
  const baseCommit = headRes.ok ? headRes.stdout.trim() : ''
  if (!baseCommit) {
    return { ok: false, error: 'The project has no commits yet to fork from.', threads: existing }
  }

  const threadId = randomUUID()
  const branch = `fabricator/thread-${threadId.slice(0, 8)}`
  const worktreePath = worktreePathFor(input.projectId, threadId)
  mkdirSync(threadsRoot(input.projectId), { recursive: true })

  const add = await git(cwd, ['worktree', 'add', '-b', branch, worktreePath, baseCommit])
  if (!add.ok) {
    return {
      ok: false,
      error: add.stderr.trim() || 'Could not create the side-thread workspace.',
      threads: existing
    }
  }

  linkNodeModules(cwd, worktreePath)

  const thread: ProjectThread = {
    id: threadId,
    name,
    branch,
    worktreePath,
    copilotSessionId: randomUUID(),
    status: 'active',
    baseBranch,
    baseCommit,
    createdAt: new Date().toISOString()
  }
  const threads = persistThreads(input.projectId, [...existing, thread])
  return { ok: true, thread, threads }
}

/** Tear down a thread's worktree + branch (used on discard and after merge). */
export async function destroyWorktree(
  projectPath: string,
  thread: Pick<ProjectThread, 'worktreePath' | 'branch'>
): Promise<void> {
  unlinkNodeModules(thread.worktreePath)
  await git(projectPath, ['worktree', 'remove', '--force', thread.worktreePath])
  if (existsSync(thread.worktreePath)) {
    try {
      rmSync(thread.worktreePath, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
  await git(projectPath, ['worktree', 'prune'])
  await git(projectPath, ['branch', '-D', thread.branch])
}

/** Discard a side thread entirely: its worktree, branch, and transcript. */
export async function removeThread(
  projectId: string,
  threadId: string
): Promise<ThreadActionResult> {
  const project = findProject(projectId)
  const existing = project?.threads ?? []
  if (!project) return { ok: false, error: 'Project not found.', threads: existing }
  const thread = existing.find((t) => t.id === threadId)
  if (!thread) return { ok: true, threads: existing }

  await destroyWorktree(project.path, thread)
  clearHistory(projectId, threadId)
  const threads = persistThreads(projectId, existing.filter((t) => t.id !== threadId))
  return { ok: true, threads }
}

/** Remove every side thread of a project (used when the project is deleted). */
export async function removeAllThreads(projectId: string): Promise<void> {
  const project = findProject(projectId)
  if (!project) return
  for (const thread of project.threads ?? []) {
    await destroyWorktree(project.path, thread)
    clearHistory(projectId, thread.id)
  }
  const root = threadsRoot(projectId)
  if (existsSync(root)) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
}
