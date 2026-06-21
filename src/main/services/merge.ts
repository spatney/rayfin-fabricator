/**
 * Merge a side thread back into a project's main branch, asking Copilot to
 * resolve any conflicts. Runs in the project's main worktree. Conflict
 * resolution is streamed into the main thread's chat (via the supplied `emit`)
 * so the user can watch the agent untangle the merge.
 *
 * Merges are serialized per project so two threads finishing at once can't
 * stomp each other (the renderer also coalesces the post-merge redeploy).
 */

import { findProject, updateProject } from './store'
import { sendMessage } from './chat'
import { COMMIT_IDENT, destroyWorktree, getThread, git } from './threads'
import type { ChatEvent, MergeResult, ProjectThread } from '../../shared/ipc'
import { MAIN_THREAD_ID } from '../../shared/ipc'

type Emit = (event: ChatEvent) => void

/** Per-project promise chain that serializes merges. */
const mergeQueues = new Map<string, Promise<unknown>>()

/** Persist a patch onto one side thread and return the project's full list. */
function patchThread(
  projectId: string,
  threadId: string,
  patch: Partial<ProjectThread>
): ProjectThread[] {
  const project = findProject(projectId)
  const threads = (project?.threads ?? []).map((t) =>
    t.id === threadId ? { ...t, ...patch } : t
  )
  updateProject(projectId, { threads })
  return threads
}

/** Commit any pending work in a worktree under Fabricator's identity. */
async function commitPending(cwd: string, message: string): Promise<void> {
  const status = await git(cwd, ['status', '--porcelain'])
  if (!status.ok || !status.stdout.trim()) return
  await git(cwd, ['add', '-A'])
  await git(cwd, [...COMMIT_IDENT, 'commit', '-m', message])
}

/** Files git still considers unmerged (conflicted) in the main worktree. */
async function conflictedFiles(cwd: string): Promise<string[]> {
  const res = await git(cwd, ['diff', '--name-only', '--diff-filter=U'])
  return res.ok ? res.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : []
}

/** True while a merge is in progress (MERGE_HEAD exists). */
async function isMerging(cwd: string): Promise<boolean> {
  const res = await git(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])
  return res.ok && res.stdout.trim().length > 0
}

function fail(projectId: string, threadId: string, error: string): MergeResult {
  const threads = patchThread(projectId, threadId, { status: 'error', lastError: error })
  return { ok: false, error, threads }
}

/** Build the conflict-resolution prompt for Copilot. */
function conflictPrompt(name: string, baseBranch: string, files: string[]): string {
  return [
    `You are resolving a git merge conflict. The side thread "${name}" is being merged into`,
    `the "${baseBranch}" branch and git reported conflicts in these files:`,
    '',
    ...files.map((f) => `  - ${f}`),
    '',
    'Edit each file to resolve every conflict, keeping BOTH changes working together where',
    'possible. Remove all conflict markers (<<<<<<<, =======, >>>>>>>). Do not run git commit',
    'or git merge — just fix the files so the project builds. When done, briefly summarize how',
    'you resolved the conflicts.'
  ].join('\n')
}

async function doMerge(projectId: string, threadId: string, emit: Emit): Promise<MergeResult> {
  const project = findProject(projectId)
  if (!project) return { ok: false, error: 'Project not found.', threads: [] }
  const thread = getThread(projectId, threadId)
  if (!thread) return { ok: false, error: 'Side thread not found.', threads: project.threads ?? [] }
  if (thread.status === 'merged') {
    return { ok: true, mergeCommit: thread.mergeCommit, threads: project.threads ?? [] }
  }

  const cwd = project.path

  // Main worktree must be on the base branch (the side branch is checked out in
  // the thread's own worktree, so main can't already be on it).
  const cur = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (cur.ok && cur.stdout.trim() !== thread.baseBranch) {
    const checkout = await git(cwd, ['checkout', thread.baseBranch])
    if (!checkout.ok) {
      return fail(projectId, threadId, `Couldn’t switch to ${thread.baseBranch} to merge.`)
    }
  }

  patchThread(projectId, threadId, { status: 'active', lastError: undefined })

  // Make sure both sides have their work committed before merging.
  await commitPending(cwd, 'Checkpoint before merging a side thread')
  await commitPending(thread.worktreePath, `Side thread work: ${thread.name}`)

  const mergeMsg = `Merge side thread: ${thread.name}`
  const merge = await git(cwd, [...COMMIT_IDENT, 'merge', '--no-ff', '-m', mergeMsg, thread.branch])

  let hadConflicts = false
  if (!merge.ok) {
    const files = await conflictedFiles(cwd)
    if (files.length === 0) {
      // Not a conflict (e.g. nothing to merge / other error) — leave main clean.
      await git(cwd, ['merge', '--abort'])
      return fail(
        projectId,
        threadId,
        merge.stderr.trim() || 'The merge could not be completed.'
      )
    }

    hadConflicts = true
    emit({
      type: 'notice',
      text: `Merging “${thread.name}” hit ${files.length} conflict${files.length > 1 ? 's' : ''} — asking Copilot to resolve…`
    })

    await sendMessage(projectId, MAIN_THREAD_ID, conflictPrompt(thread.name, thread.baseBranch, files), emit)

    // Whatever the agent did, the markers must be gone and nothing left unmerged.
    const markers = await git(cwd, ['diff', '--check'])
    const stillUnmerged = await conflictedFiles(cwd)
    if (stillUnmerged.length > 0 || !markers.ok) {
      if (await isMerging(cwd)) await git(cwd, ['merge', '--abort'])
      return fail(
        projectId,
        threadId,
        'Copilot couldn’t fully resolve the merge conflicts. The side thread was left intact so you can try again.'
      )
    }

    // Finish the merge commit if the agent didn't already commit it.
    if (await isMerging(cwd)) {
      await git(cwd, ['add', '-A'])
      const commit = await git(cwd, [...COMMIT_IDENT, 'commit', '--no-edit'])
      if (!commit.ok) {
        if (await isMerging(cwd)) await git(cwd, ['merge', '--abort'])
        return fail(projectId, threadId, commit.stderr.trim() || 'Could not finalize the merge.')
      }
    }
  }

  const headRes = await git(cwd, ['rev-parse', 'HEAD'])
  const mergeCommit = headRes.ok ? headRes.stdout.trim() : undefined

  // Success: the work now lives on main — tear down the thread's worktree/branch.
  await destroyWorktree(cwd, thread)
  const threads = patchThread(projectId, threadId, {
    status: 'merged',
    mergedAt: new Date().toISOString(),
    mergeCommit,
    lastError: undefined
  })
  emit({ type: 'notice', text: `Merged “${thread.name}” into ${thread.baseBranch}.` })
  return { ok: true, hadConflicts, mergeCommit, threads }
}

/**
 * Merge a side thread into main (serialized per project). On success the thread
 * is marked merged and its worktree/branch removed; the caller then redeploys.
 */
export async function mergeThread(
  projectId: string,
  threadId: string,
  emit: Emit
): Promise<MergeResult> {
  const prior = mergeQueues.get(projectId) ?? Promise.resolve()
  const next = prior.then(() => doMerge(projectId, threadId, emit)).catch((err) => {
    const message = err instanceof Error ? err.message : String(err)
    return fail(projectId, threadId, message)
  })
  mergeQueues.set(
    projectId,
    next.finally(() => {
      if (mergeQueues.get(projectId) === next) mergeQueues.delete(projectId)
    })
  )
  return next
}
