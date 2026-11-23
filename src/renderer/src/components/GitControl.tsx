import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { GitBranch, GitRemoteStatus, GitStatus, GitSyncResult } from '../../../shared/ipc'
import { useTranslation } from '../i18n'
import { useSuppressPreview } from '../overlay'
import { useToast } from '../toast'
import { Codicon } from './icons'
import GithubRepoFields, {
  NEW_GITHUB_REPO,
  githubRepoName,
  type GithubRepoChoice
} from './github/GithubRepoFields'

interface Props {
  projectId: string
  /** Bumped by the parent when the working tree likely changed (deploy/turn). */
  refreshKey: number
  /** A chat turn is running: what would change the app's files waits for it. */
  busy?: boolean
  /**
   * Called after a commit, pull, push, merge or switch of branch went through,
   * so the parent can refresh the app; `packagesChanged` when it changed the
   * app's packages, which need installing again.
   */
  onSynced?: (packagesChanged?: boolean) => void
  /** Send Copilot a request in the app's chat (`display` is what the chat shows). */
  onSendToChat?: (display: string, prompt: string) => void
  /** The project's folder name: a new GitHub repository is named after it. */
  folderName?: string
  /** Open setup, to install the GitHub CLI. */
  onReviewSetup?: () => void
}

/** How often we re-fetch the remote to keep ahead/behind fresh (ms). */
const FETCH_PERIOD_MS = 3 * 60 * 1000
/** Conflicted files the popover names before "and N more". */
const SHOWN_CONFLICTS = 4

type Syncing = 'pull' | 'push' | 'merge' | 'finish' | 'abort' | 'switch'

const FAILED = {
  pull: 'control.failed.pull',
  push: 'control.failed.push',
  merge: 'control.failed.merge',
  finish: 'control.failed.finish',
  abort: 'control.failed.abort',
  switch: 'control.failed.switch'
} as const satisfies Record<Syncing, string>

/** What Copilot is asked to do with a merge's conflicts (files relative to the project). */
export function conflictsPrompt(files: string[], branch?: string): string {
  return [
    `Getting the latest changes${branch ? ` into ${branch}` : ''} stopped at merge conflicts: git started the merge and marked where my changes and the latest ones overlap, in ${files.length === 1 ? 'this file' : 'these files'} (relative to the project folder):`,
    ...files.map((file) => `- ${file}`),
    '',
    'Resolve every conflict: read both sides, keep what each side meant to do, and remove all the conflict markers (<<<<<<<, ======= and >>>>>>>). Where package.json conflicted, settle it first, then run npm install so package-lock.json follows it, rather than merging the lockfile by hand.',
    'Then check that the app still type-checks and builds, and fix what the combined changes broke.',
    'When you’re done, finish the merge: git add the files you resolved, then git commit --no-edit. Don’t abort or reset the merge, and don’t push.'
  ].join('\n')
}

/**
 * Compact git status pill for the status bar: shows the branch, the number of
 * uncommitted changes (or a merge's conflicts), and — when the repo has a
 * remote — how many changes are waiting to be pulled (behind) or pushed
 * (ahead). The popover switches branches, gets the latest changes, pushes and
 * commits. When your changes and the latest ones overlap, it merges them and
 * asks Copilot to resolve the conflicts, then finishes (or cancels) the merge.
 * A project with no remote yet can get a GitHub repository from it.
 */
export default function GitControl({
  projectId,
  refreshKey,
  busy: chatBusy = false,
  onSynced,
  onSendToChat,
  folderName,
  onReviewSetup
}: Props): JSX.Element | null {
  const { t } = useTranslation('git')
  const toast = useToast()
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [remote, setRemote] = useState<GitRemoteStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'main' | 'branches' | 'github'>('main')
  const [repoName, setRepoName] = useState('')
  const [repoChoice, setRepoChoice] = useState<GithubRepoChoice>(NEW_GITHUB_REPO)
  const [repoReady, setRepoReady] = useState(false)
  const [creatingRepo, setCreatingRepo] = useState(false)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  /** Copilot is writing the commit message. */
  const [writing, setWriting] = useState(false)
  const [syncing, setSyncing] = useState<Syncing | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** The last pull found your changes and the latest ones overlap. */
  const [overlap, setOverlap] = useState(false)
  const [branches, setBranches] = useState<GitBranch[] | null>(null)
  const [query, setQuery] = useState('')
  const [switchingTo, setSwitchingTo] = useState<string | null>(null)
  const fetchRef = useRef<Promise<void> | null>(null)
  const projectRef = useRef(projectId)
  projectRef.current = projectId
  const inputRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setStatus(await window.api.projects.git.status(projectId))
  }, [projectId])

  // Network-touching: runs `git fetch` to refresh the known divergence. One at
  // a time, so overlapping ticks (timer + refreshKey + manual) don't pile up.
  const loadRemote = useCallback((): Promise<void> => {
    if (fetchRef.current) return fetchRef.current
    const fetching = (async () => {
      try {
        setRemote(await window.api.projects.git.remoteStatus(projectId))
      } finally {
        fetchRef.current = null
      }
    })()
    fetchRef.current = fetching
    return fetching
  }, [projectId])

  useEffect(() => {
    void refresh()
    void loadRemote()
  }, [refresh, loadRemote, refreshKey])

  // Periodically re-fetch (skipped while the window is hidden), and refresh on focus.
  useEffect(() => {
    const tick = (): void => {
      if (!document.hidden) void loadRemote()
    }
    const timer = window.setInterval(tick, FETCH_PERIOD_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [loadRemote])

  // Close the popover on any outside click.
  useEffect(() => {
    if (!open) return
    const close = (): void => setOpen(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [open])

  // Each opening starts on the main view, without the last one's error.
  useEffect(() => {
    if (open) return
    setView('main')
    setQuery('')
    setError(null)
    setOverlap(false)
    setRepoName('')
  }, [open])

  // The popover is HTML; the live preview is a native webview that paints above
  // all HTML, so it must be hidden (frozen to a still frame) while the popover
  // is open — otherwise the popover renders behind the preview.
  useSuppressPreview(open)

  if (!status || !status.isRepo) return null

  const dirty = status.changedCount > 0
  const behind = remote?.behind ?? 0
  const ahead = remote?.ahead ?? 0
  const canPush = ahead > 0 && Boolean(remote?.hasUpstream)
  const merging = Boolean(status.merging)
  /** No remote yet: it can get a GitHub repository. */
  const canCreateRepo = Boolean(remote?.isRepo && !remote.hasRemote) && !status.noCommits
  const conflicts = status.conflicts ?? []
  const locked = chatBusy || syncing !== null || busy
  const waitTitle = chatBusy ? t('control.waitForCopilot') : undefined

  async function commit(): Promise<void> {
    const msg = message.trim()
    if (!msg) return
    setBusy(true)
    setError(null)
    try {
      const res = await window.api.projects.git.commit(projectId, msg)
      setStatus(res.status)
      if (!res.ok) {
        setError(res.error ?? t('control.commitFailed'))
        return
      }
      setMessage('')
      void loadRemote()
      onSynced?.()
    } finally {
      setBusy(false)
    }
  }

  /** Have Copilot, on its Auto model, write the message from the changes. */
  async function writeMessage(): Promise<void> {
    const asked = projectId
    let wrote = false
    setWriting(true)
    setError(null)
    try {
      const res = await window.api.projects.git.message(asked)
      if (projectRef.current !== asked) return
      if (res.ok && res.message) {
        setMessage(res.message)
        wrote = true
      } else {
        setError(res.error ?? t('control.messageFailed'))
      }
    } catch (reason) {
      if (projectRef.current === asked) {
        setError(reason instanceof Error ? reason.message : t('control.messageFailed'))
      }
    } finally {
      setWriting(false)
      // The box is disabled while Copilot writes; focus it once it's back, to edit or commit.
      if (wrote) requestAnimationFrame(() => inputRef.current?.focus())
    }
  }

  /** Run a sync, taking its status; one that went through tells the parent. */
  async function sync(
    kind: Syncing,
    call: (id: string) => Promise<GitSyncResult>
  ): Promise<GitSyncResult | null> {
    setSyncing(kind)
    setError(null)
    try {
      const res = await call(projectId)
      setStatus(res.status)
      setRemote(res.remote)
      if (res.ok) onSynced?.(res.packagesChanged)
      else setError(res.error ?? t(FAILED[kind]))
      return res
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t(FAILED[kind]))
      return null
    } finally {
      setSyncing(null)
    }
  }

  /** Close once nothing is left to do here. */
  function closeIfSynced(res: GitSyncResult): void {
    if (
      res.status.changedCount === 0 &&
      !res.status.merging &&
      res.remote.behind === 0 &&
      res.remote.ahead === 0
    ) {
      setOpen(false)
    }
  }

  async function pull(): Promise<void> {
    const res = await sync('pull', window.api.projects.git.pull)
    setOverlap(Boolean(res && !res.ok && res.conflict))
    if (res?.ok) closeIfSynced(res)
  }

  async function push(): Promise<void> {
    const res = await sync('push', window.api.projects.git.push)
    if (res?.ok && res.remote.ahead === 0) setOpen(false)
  }

  function askCopilot(files: string[]): void {
    if (!onSendToChat || files.length === 0) return
    onSendToChat(
      files.length === 1
        ? t('control.resolveConflict', { file: files[0] })
        : t('control.resolveConflicts', { count: files.length }),
      conflictsPrompt(files, status?.branch)
    )
    setOpen(false)
  }

  /** Merge the latest changes for Copilot to resolve; one that goes through on its own is done. */
  async function mergeLatest(): Promise<void> {
    const res = await sync('merge', window.api.projects.git.mergeLatest)
    setOverlap(false)
    if (!res) return
    if (res.ok) closeIfSynced(res)
    else if (res.conflict && res.status.conflicts?.length) askCopilot(res.status.conflicts)
  }

  async function finishMerge(): Promise<void> {
    const res = await sync('finish', window.api.projects.git.finishMerge)
    if (res?.ok) closeIfSynced(res)
  }

  async function abortMerge(): Promise<void> {
    const res = await sync('abort', window.api.projects.git.abortMerge)
    if (res?.ok) closeIfSynced(res)
  }

  async function loadBranches(): Promise<void> {
    try {
      const list = await window.api.projects.git.branches(projectId)
      if (projectRef.current === projectId) setBranches(list.branches)
    } catch {
      if (projectRef.current === projectId) setBranches([])
    }
  }

  /** The branch list, as known now and again once the remote's been fetched. */
  function showBranches(): void {
    setView('branches')
    setBranches(null)
    setQuery('')
    setError(null)
    void loadBranches()
    void loadRemote().then(loadBranches, () => undefined)
  }

  async function switchTo(name: string): Promise<void> {
    setSwitchingTo(name)
    const res = await sync('switch', (id) => window.api.projects.git.switchBranch(id, name))
    setSwitchingTo(null)
    if (res?.ok) setOpen(false)
  }

  /** Ask for a GitHub repository, named after the app's folder until the name's changed. */
  function showGithub(): void {
    setView('github')
    setError(null)
    setRepoName((current) => current || githubRepoName(folderName ?? ''))
  }

  async function createRepo(): Promise<void> {
    const asked = projectId
    setCreatingRepo(true)
    setError(null)
    try {
      const res = await window.api.github.createRepo(asked, {
        ...repoChoice,
        name: repoName.trim()
      })
      if (projectRef.current !== asked) return
      if (!res.ok) {
        setError(res.error ?? t('control.createRepoFailed'))
        return
      }
      const where = res.url?.replace(/^https:\/\//, '')
      toast.success(
        where === undefined ? t('control.createdNoUrl') : t('control.created', { where }),
        { title: t('control.onGithub') }
      )
      setOpen(false)
      void refresh()
      void loadRemote()
    } catch (reason) {
      if (projectRef.current === asked) {
        setError(reason instanceof Error ? reason.message : t('control.createRepoFailed'))
      }
    } finally {
      setCreatingRepo(false)
    }
  }

  const chipLabel = merging
    ? conflicts.length
      ? t('control.conflicts', { count: conflicts.length })
      : t('control.merging')
    : dirty
      ? t('control.uncommitted', { count: status.changedCount })
      : t('control.clean')
  const pushes =
    status.branch === undefined
      ? t('control.pushesThisBranch')
      : t('control.pushesBranch', { branch: status.branch })
  const q = query.trim().toLowerCase()
  const shown = (branches ?? []).filter((b) => b.name.toLowerCase().includes(q))
  const localShown = shown.filter((b) => !b.remote)
  const remoteShown = shown.filter((b) => b.remote)

  const branchItem = (b: GitBranch): JSX.Element => {
    const current = !b.remote && b.name === status.branch
    return (
      <button
        key={b.name}
        type="button"
        className="git-branch-item"
        aria-current={current || undefined}
        disabled={locked || current}
        title={waitTitle}
        onClick={() => void switchTo(b.name)}
      >
        <Codicon
          name={current ? 'check' : b.remote ? 'cloud' : 'git-branch'}
          className="git-branch-ico"
        />
        <span className="git-branch-name">{b.name}</span>
        {switchingTo === b.name && (
          <span className="git-branch-note">{t('control.switching')}</span>
        )}
      </button>
    )
  }

  return (
    <div className="git-control" onClick={(e) => e.stopPropagation()}>
      <button
        className={`chip git-chip git-chip--actionable${merging ? ' git-chip--conflict' : dirty ? ' git-chip--dirty' : ' git-chip--clean'}`}
        title={status.branch ? t('control.branchTitle', { branch: status.branch }) : 'git'}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          void refresh()
          void loadRemote()
          setOpen((o) => !o)
        }}
      >
        <Codicon name="git-branch" className="statusbar-ico" />
        <span className="git-branch">{status.branch ?? 'git'}</span>
        <span className="git-dot" aria-hidden="true">
          ·
        </span>
        <span className="git-count">{chipLabel}</span>
        {(behind > 0 || ahead > 0) && (
          <span className="git-sync-badges">
            {behind > 0 && (
              <span
                className="git-badge git-badge--behind"
                title={t('control.behind', { count: behind })}
              >
                ↓{behind}
              </span>
            )}
            {ahead > 0 && (
              <span
                className="git-badge git-badge--ahead"
                title={t('control.ahead', { count: ahead })}
              >
                ↑{ahead}
              </span>
            )}
          </span>
        )}
      </button>

      {open && (
        <div
          className="git-popover"
          role="dialog"
          aria-label="Git"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            if (view !== 'main') setView('main')
            else setOpen(false)
          }}
        >
          {view === 'github' ? (
            <>
              <div className="git-branches-head">
                <button
                  type="button"
                  className="git-back"
                  aria-label={t('actions.back')}
                  disabled={creatingRepo}
                  onClick={() => setView('main')}
                >
                  <Codicon name="arrow-left" />
                </button>
                <span className="git-sync-title">{t('control.createRepo')}</span>
              </div>
              <GithubRepoFields
                compact
                name={repoName}
                onNameChange={setRepoName}
                value={repoChoice}
                onChange={setRepoChoice}
                onReady={setRepoReady}
                disabled={creatingRepo}
                onReviewSetup={
                  onReviewSetup &&
                  (() => {
                    setOpen(false)
                    onReviewSetup()
                  })
                }
              />
              <div className="git-sync-sub">
                {dirty
                  ? t('sentences', {
                      first: pushes,
                      second: t('control.staysHere', { count: status.changedCount })
                    })
                  : pushes}
              </div>
              {error && <div className="git-error">{error}</div>}
              <div className="git-popover-actions">
                <button
                  className="btn btn--xs btn--ghost"
                  disabled={creatingRepo}
                  onClick={() => setView('main')}
                >
                  {t('actions.cancel')}
                </button>
                <button
                  className="btn btn--xs btn--primary"
                  disabled={!repoReady || creatingRepo || syncing !== null || busy}
                  onClick={() => void createRepo()}
                >
                  {creatingRepo ? t('control.creating') : t('control.createRepository')}
                </button>
              </div>
            </>
          ) : view === 'branches' ? (
            <>
              <div className="git-branches-head">
                <button
                  type="button"
                  className="git-back"
                  aria-label={t('actions.back')}
                  onClick={() => setView('main')}
                >
                  <Codicon name="arrow-left" />
                </button>
                <span className="git-sync-title">{t('control.switchBranch')}</span>
              </div>
              <input
                className="git-msg-input"
                placeholder={t('control.filterBranches')}
                aria-label={t('control.filterBranches')}
                value={query}
                autoFocus
                spellCheck={false}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className="git-branch-list" role="group" aria-label={t('control.branches')}>
                {localShown.map(branchItem)}
                {remoteShown.length > 0 && (
                  <div className="git-branch-heading" aria-hidden="true">
                    {t('control.onRemote')}
                  </div>
                )}
                {remoteShown.map(branchItem)}
                {branches === null && (
                  <div className="git-branch-empty shimmer-text">
                    {t('control.loadingBranches')}
                  </div>
                )}
                {branches !== null && shown.length === 0 && (
                  <div className="git-branch-empty">
                    {q
                      ? t('control.noBranchesMatch', { query: query.trim() })
                      : t('control.noOtherBranches')}
                  </div>
                )}
              </div>
              {dirty && (
                <div className="git-sync-sub">
                  {status.branch === undefined
                    ? t('control.savedOnThisBranch', { count: status.changedCount })
                    : t('control.savedOnBranch', {
                        count: status.changedCount,
                        branch: status.branch
                      })}
                </div>
              )}
              {error && <div className="git-error">{error}</div>}
            </>
          ) : (
            <>
              {merging ? (
                <div className="git-merge">
                  <div className="git-sync-title">
                    {conflicts.length
                      ? t('control.filesConflict', { count: conflicts.length })
                      : t('control.resolved')}
                  </div>
                  <div className="git-sync-sub">
                    {conflicts.length ? t('control.stoppedAtConflicts') : t('control.finishToSave')}
                  </div>
                  {conflicts.length > 0 && (
                    <ul className="git-conflicts">
                      {conflicts.slice(0, SHOWN_CONFLICTS).map((file) => (
                        <li key={file}>{file}</li>
                      ))}
                      {conflicts.length > SHOWN_CONFLICTS && (
                        <li className="git-conflicts-more">
                          {t('control.andMore', { count: conflicts.length - SHOWN_CONFLICTS })}
                        </li>
                      )}
                    </ul>
                  )}
                  <div className="git-popover-actions">
                    <button
                      className="btn btn--xs btn--ghost"
                      disabled={locked}
                      title={waitTitle}
                      onClick={() => void abortMerge()}
                    >
                      {syncing === 'abort' ? t('control.cancelling') : t('control.cancelMerge')}
                    </button>
                    {conflicts.length > 0 ? (
                      onSendToChat && (
                        <button
                          className="btn btn--xs btn--primary"
                          disabled={locked}
                          title={waitTitle}
                          onClick={() => askCopilot(conflicts)}
                        >
                          <Codicon name="sparkle" /> {t('control.askCopilot')}
                        </button>
                      )
                    ) : (
                      <button
                        className="btn btn--xs btn--primary"
                        disabled={locked}
                        title={waitTitle}
                        onClick={() => void finishMerge()}
                      >
                        {syncing === 'finish' ? t('control.finishing') : t('control.finishMerge')}
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="git-sync-row">
                  <div className="git-sync-text">
                    <div className="git-sync-title git-current">
                      <Codicon name="git-branch" />
                      <span className="git-branch-name">
                        {status.branch ?? t('control.noBranch')}
                      </span>
                    </div>
                    <div className="git-sync-sub">{t('control.currentBranch')}</div>
                  </div>
                  <button
                    className="btn btn--xs btn--ghost"
                    disabled={locked || Boolean(status.noCommits)}
                    title={waitTitle}
                    onClick={showBranches}
                  >
                    {t('control.switch')}
                  </button>
                </div>
              )}

              {!merging && canCreateRepo && (
                <div className="git-sync-row">
                  <div className="git-sync-text">
                    <div className="git-sync-title">{t('control.notOnGithub')}</div>
                    <div className="git-sync-sub">{t('control.keepVersions')}</div>
                  </div>
                  <button
                    className="btn btn--xs btn--ghost"
                    aria-label={t('control.createRepo')}
                    disabled={syncing !== null || busy}
                    onClick={showGithub}
                  >
                    {t('control.create')}
                  </button>
                </div>
              )}

              {!merging && behind > 0 && (
                <div className="git-sync-row">
                  <div className="git-sync-text">
                    <div className="git-sync-title">{t('control.getLatestChanges')}</div>
                    <div className="git-sync-sub">{t('control.waiting', { count: behind })}</div>
                  </div>
                  <button
                    className="btn btn--xs btn--primary"
                    disabled={locked}
                    title={waitTitle}
                    onClick={() => void pull()}
                  >
                    {syncing === 'pull' ? t('control.getting') : t('control.getLatest')}
                  </button>
                </div>
              )}

              {!merging && overlap && (
                <div className="git-overlap">
                  <div className="git-error">{error}</div>
                  {onSendToChat && (
                    <div className="git-popover-actions">
                      <button
                        className="btn btn--xs btn--primary"
                        disabled={locked}
                        title={waitTitle}
                        onClick={() => void mergeLatest()}
                      >
                        {syncing === 'merge' ? (
                          t('control.combining')
                        ) : (
                          <>
                            <Codicon name="sparkle" /> {t('control.askCopilot')}
                          </>
                        )}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {!merging && canPush && (
                <div className="git-sync-row">
                  <div className="git-sync-text">
                    <div className="git-sync-title">{t('control.pushChanges')}</div>
                    <div className="git-sync-sub">{t('control.readyToPush', { count: ahead })}</div>
                  </div>
                  <button
                    className="btn btn--xs btn--ghost"
                    disabled={syncing !== null || busy}
                    onClick={() => void push()}
                  >
                    {syncing === 'push' ? t('control.pushing') : t('control.push')}
                  </button>
                </div>
              )}

              {!merging && dirty && <div className="git-popover-divider" />}

              {!merging && dirty && (
                <>
                  <div className="git-popover-title">
                    {status.branch
                      ? t('control.commitChangesOn', {
                          count: status.changedCount,
                          branch: status.branch
                        })
                      : t('control.commitChanges', { count: status.changedCount })}
                  </div>
                  <div className="git-msg-field">
                    <input
                      ref={inputRef}
                      className="git-msg-input"
                      placeholder={
                        writing ? t('control.writingMessage') : t('control.commitMessage')
                      }
                      aria-label={t('control.commitMessage')}
                      value={message}
                      autoFocus
                      spellCheck={false}
                      disabled={busy || writing || syncing !== null}
                      onChange={(e) => setMessage(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void commit()
                      }}
                    />
                    <button
                      type="button"
                      className="git-msg-write"
                      aria-label={t('control.writeMessage')}
                      title={t('control.writeMessageAuto')}
                      disabled={busy || writing || syncing !== null}
                      onClick={() => void writeMessage()}
                    >
                      <Codicon
                        name={writing ? 'loading' : 'sparkle'}
                        className={writing ? 'codicon-modifier-spin' : ''}
                      />
                    </button>
                  </div>
                </>
              )}

              {error && !overlap && <div className="git-error">{error}</div>}

              {!merging && dirty && (
                <div className="git-popover-actions">
                  <button
                    className="btn btn--xs btn--ghost"
                    disabled={busy}
                    onClick={() => setOpen(false)}
                  >
                    {t('actions.cancel')}
                  </button>
                  <button
                    className="btn btn--xs btn--primary"
                    disabled={busy || writing || syncing !== null || !message.trim()}
                    onClick={() => void commit()}
                  >
                    {busy ? t('control.committing') : t('control.commitAll')}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
