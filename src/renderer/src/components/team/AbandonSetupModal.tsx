import { useEffect, useId, useMemo, useState, type JSX } from 'react'
import type { TeamAbandonItem, TeamAbandonPlan, TeamActionResult, TeamProblem, TeamWorkspace } from '@shared/ipc'
import { useSuppressPreview } from '../../overlay'
import { useModalFocus } from '../../modalFocus'
import { ProblemView, StepList, teamError, useStepProgress, type StepRow } from './common'
import './team.css'

const KIND_LABEL: Record<TeamAbandonItem['kind'], string> = {
  identity: 'Deploy identity',
  trust: 'Its federated credentials for this workspace',
  fabric: 'Fabric workspace',
  pipeline: 'Fabricator’s files and settings in it',
  github: 'GitHub repository',
  local: 'Folder on this computer'
}

const KIND_ICON: Record<TeamAbandonItem['kind'], string> = {
  identity: 'key',
  trust: 'shield',
  fabric: 'layers',
  pipeline: 'github-action',
  github: 'github',
  local: 'folder'
}

const LOOKUP_FAILED = 'Could not look up what setup created.'

/** The cleanup checklist for these items. Mirrors ABANDON_STEPS in src-tauri/src/commands/team/abandon.rs. */
export function abandonSteps(items: TeamAbandonItem[]): Array<{ id: string; label: string }> {
  const count = (kind: TeamAbandonItem['kind']): number => items.filter((i) => i.kind === kind).length
  const identities = count('identity')
  const fabric = count('fabric')
  return [
    { id: 'check', label: 'Look up what setup created' },
    ...(identities
      ? [{ id: 'identity', label: identities === 1 ? 'Delete the deploy identity' : 'Delete the deploy identities' }]
      : []),
    ...(count('trust') ? [{ id: 'trust', label: 'Remove the federated credentials from your app registration' }] : []),
    ...(fabric ? [{ id: 'fabric', label: fabric === 1 ? 'Delete the Fabric workspace' : 'Delete the Fabric workspaces' }] : []),
    ...(count('pipeline') ? [{ id: 'cleanup', label: 'Remove Fabricator’s files and settings from the repository' }] : []),
    ...(count('github') ? [{ id: 'github', label: 'Delete the GitHub repository' }] : []),
    { id: 'local', label: 'Remove the workspace from this computer' }
  ]
}

function pending(steps: Array<{ id: string; label: string }>): StepRow[] {
  return steps.map((s) => ({ ...s, state: 'pending' }))
}

/** Whether the setup record still holds this item (the cleanup forgets each one it deletes). */
export function stillThere(item: TeamAbandonItem, workspace: TeamWorkspace): boolean {
  const setup = workspace.setup
  switch (item.kind) {
    case 'identity':
      return item.id === setup?.appId || item.id === setup?.previewAppId
    case 'trust':
      // Removing the credentials takes the trust step back off the record.
      return item.id === setup?.appId && Boolean(setup?.completed.includes('trust'))
    case 'fabric':
      return item.id === setup?.productionWorkspaceId || item.id === setup?.previewsWorkspaceId
    case 'pipeline':
    case 'github':
      return item.id.toLowerCase() === workspace.repo.toLowerCase()
    default:
      return false
  }
}

function ItemList({ items }: { items: TeamAbandonItem[] }): JSX.Element {
  return (
    <ul className="team-abandon-items">
      {items.map((item) => (
        <li key={`${item.kind}:${item.id}`} className="team-abandon-item">
          <span className={`codicon codicon-${KIND_ICON[item.kind]}`} aria-hidden="true" />
          <span className="team-abandon-name" title={item.name}>
            {item.url ? (
              <button type="button" className="link-btn" onClick={() => void window.api.openExternal(item.url!)}>
                {item.name}
              </button>
            ) : (
              item.name
            )}
          </span>
          <span className="team-abandon-kind">{KIND_LABEL[item.kind]}</span>
        </li>
      ))}
    </ul>
  )
}

type Phase = 'checking' | 'confirm' | 'running' | 'failed'

interface Props {
  workspace: TeamWorkspace
  onClose: () => void
  /** The workspace is no longer on this computer (abandoned, or removed from here). */
  onGone: () => void
  /** Some of what setup created was deleted before a problem stopped the rest. */
  onChanged: () => void
}

/**
 * Abandons a team workspace's unfinished setup: lists what setup created, then
 * deletes it and removes the workspace from this computer.
 */
export default function AbandonSetupModal({ workspace, onClose, onGone, onChanged }: Props): JSX.Element {
  useSuppressPreview()
  const titleId = useId()
  const dialogRef = useModalFocus<HTMLDivElement>()
  const scope = useMemo(() => `team-abandon-${crypto.randomUUID()}`, [])
  const [phase, setPhase] = useState<Phase>('checking')
  const [plan, setPlan] = useState<TeamAbandonPlan | null>(null)
  /** The workspace's record as the last cleanup attempt left it. */
  const [latest, setLatest] = useState<TeamWorkspace>(workspace)
  const [problem, setProblem] = useState<TeamProblem | null>(null)
  /** The cleanup ran (so the checklist shows what it got through). */
  const [ran, setRan] = useState(false)
  const [needsPermission, setNeedsPermission] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [grantError, setGrantError] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)
  const steps = useMemo(() => abandonSteps(plan?.items ?? []), [plan])
  const [rows, setRows] = useStepProgress(steps, scope)
  const busy = phase === 'running' || removing
  const hasRepo = Boolean(plan?.items.some((i) => i.kind === 'github'))

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  async function check(): Promise<void> {
    setPhase('checking')
    setProblem(null)
    setRan(false)
    let next: TeamAbandonPlan
    try {
      next = await window.api.team.abandonPlan(workspace.id)
    } catch (reason) {
      next = { ok: false, error: teamError(reason, LOOKUP_FAILED), items: [], kept: [], needsDeletePermission: false }
    }
    setPlan(next)
    setNeedsPermission(next.needsDeletePermission)
    if (next.ok) {
      setPhase('confirm')
      return
    }
    setProblem(next.problem ?? { step: 'check', message: next.error ?? LOOKUP_FAILED })
    setPhase('failed')
  }

  useEffect(() => {
    void check()
  }, [workspace.id])

  /** Ask GitHub again whether the workspace's account may delete repositories. */
  async function checkPermission(): Promise<boolean> {
    try {
      const status = await window.api.team.envStatus(workspace.account)
      setNeedsPermission(hasRepo && status.ghSignedIn && !status.ghCanDeleteRepos)
      return status.ghCanDeleteRepos
    } catch {
      return false
    }
  }

  useEffect(() => {
    if (!waiting) return
    const id = window.setInterval(() => {
      void checkPermission().then((granted) => {
        if (granted) setWaiting(false)
      })
    }, 3000)
    const stop = window.setTimeout(() => setWaiting(false), 5 * 60_000)
    return () => {
      window.clearInterval(id)
      window.clearTimeout(stop)
    }
  }, [waiting])

  async function grant(): Promise<void> {
    setGrantError(null)
    try {
      const result = await window.api.team.githubSignIn(true, true, workspace.account)
      if (!result.ok) {
        setGrantError(result.error ?? 'Could not start GitHub sign-in.')
        return
      }
      setWaiting(true)
    } catch (reason) {
      setGrantError(teamError(reason, 'Could not start GitHub sign-in.'))
    }
  }

  async function run(): Promise<void> {
    setProblem(null)
    setRows(pending(steps))
    setRan(true)
    setPhase('running')
    let result: TeamActionResult
    try {
      result = await window.api.team.abandonSetup(workspace.id, scope)
    } catch (reason) {
      result = { ok: false, error: teamError(reason, 'Abandoning the setup stopped unexpectedly.') }
    }
    if (result.ok) {
      onGone()
      return
    }
    if (result.workspace) setLatest(result.workspace)
    onChanged()
    const next = result.problem ?? { step: 'check', message: result.error ?? 'Abandoning the setup stopped.' }
    setProblem(next)
    setPhase('failed')
    if (next.step === 'github') void checkPermission()
  }

  async function removeHere(): Promise<void> {
    setRemoving(true)
    try {
      await window.api.team.leave(workspace.id)
      onGone()
    } catch (reason) {
      setProblem({ step: 'local', message: teamError(reason, 'Could not remove the workspace from this computer.') })
      setPhase('failed')
    } finally {
      setRemoving(false)
    }
  }

  // What "Remove from this computer" would leave behind.
  const items = plan?.items ?? []
  const left = items.filter((i) => stillThere(i, latest))
  const deletes = items.some((i) => i.kind !== 'local')

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div
        className="modal team-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={titleId}>Abandon setting up {workspace.name}?</h2>
        </div>
        <div className="modal-body team-form">
          {phase === 'checking' && (
            <div className="team-muted" role="status">
              <span className="ws-spinner" /> Looking up what setup created…
            </div>
          )}

          {phase === 'confirm' && plan && (
            <>
              {items.length > 0 ? (
                <>
                  <p className="team-muted">
                    {items.some((i) => i.kind === 'trust' || i.kind === 'pipeline')
                      ? 'Fabricator permanently deletes what setup created so far and removes what it added to what you provided, then removes the workspace from this computer:'
                      : 'Fabricator permanently deletes what setup created so far, then removes the workspace from this computer:'}
                  </p>
                  <ItemList items={items} />
                </>
              ) : (
                <p className="team-muted">
                  Nothing that setup created is left. Fabricator removes the workspace from this computer.
                </p>
              )}
              {plan.kept.map((note) => (
                <p key={note} className="team-muted">
                  {note}
                </p>
              ))}
            </>
          )}

          {(phase === 'running' || (phase === 'failed' && ran)) && <StepList rows={rows} />}
          {phase === 'failed' && problem && <ProblemView problem={problem} />}

          {needsPermission && hasRepo && (phase === 'confirm' || phase === 'failed') && (
            <div className="team-check">
              <span className="team-check-dot team-check-dot--warn" />
              <span className="team-check-text">
                <strong>GitHub</strong>
                <div className="team-muted">
                  Deleting the repository needs one more GitHub permission (delete_repo). GitHub asks you to
                  approve it.
                </div>
              </span>
              <button type="button" className="btn btn--sm btn--primary" onClick={() => void grant()}>
                {waiting ? 'Waiting…' : 'Grant GitHub access'}
              </button>
            </div>
          )}
          {waiting && (
            <p className="team-muted">
              Finish signing in in the terminal window, then come back. This updates automatically.
            </p>
          )}
          {grantError && <div className="alert alert--error">{grantError}</div>}

          {phase === 'failed' && (
            <p className="team-muted">
              {plan?.ok && left.length > 0
                ? `Remove from this computer keeps what's left: ${left.map((i) => i.name).join(', ')}.`
                : plan?.ok
                  ? 'Remove from this computer forgets the workspace here.'
                  : 'Remove from this computer keeps everything setup created.'}
            </p>
          )}
        </div>
        <div className="modal-footer">
          {phase !== 'checking' && phase !== 'running' && (
            <button
              type="button"
              className="btn btn--ghost team-footer-start"
              disabled={busy}
              onClick={() => void removeHere()}
            >
              {removing ? 'Removing…' : 'Remove from this computer'}
            </button>
          )}
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          {phase === 'failed' ? (
            <button
              key="retry"
              type="button"
              className="btn btn--primary"
              disabled={busy || (ran && needsPermission && hasRepo)}
              onClick={() => void (ran ? run() : check())}
            >
              Try again
            </button>
          ) : (
            <button
              key="delete"
              type="button"
              className="btn btn--danger"
              disabled={phase !== 'confirm' || busy || (needsPermission && hasRepo)}
              onClick={() => void run()}
            >
              {phase === 'running' ? (
                <span className="btn-busy">
                  <span className="btn-spin" aria-hidden="true" />
                  Deleting…
                </span>
              ) : deletes || phase === 'checking' ? (
                'Delete and abandon'
              ) : (
                'Abandon setup'
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
