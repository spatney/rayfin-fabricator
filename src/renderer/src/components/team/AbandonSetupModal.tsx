import { useEffect, useId, useMemo, useState, type JSX } from 'react'
import type { TeamAbandonItem, TeamAbandonPlan, TeamActionResult, TeamProblem, TeamWorkspace } from '@shared/ipc'
import { translator, useTranslation } from '../../i18n'
import { useSuppressPreview } from '../../overlay'
import { useModalFocus } from '../../modalFocus'
import { ProblemView, StepList, teamError, useStepProgress, type StepRow } from './common'
import './team.css'

const KIND_LABEL = {
  identity: 'abandon.kind.identity',
  trust: 'abandon.kind.trust',
  fabric: 'abandon.kind.fabric',
  pipeline: 'abandon.kind.pipeline',
  github: 'abandon.kind.github',
  local: 'abandon.kind.local'
} as const satisfies Record<TeamAbandonItem['kind'], string>

const KIND_ICON: Record<TeamAbandonItem['kind'], string> = {
  identity: 'key',
  trust: 'shield',
  fabric: 'layers',
  pipeline: 'github-action',
  github: 'github',
  local: 'folder'
}

/** The cleanup checklist for these items. Mirrors ABANDON_STEPS in src-tauri/src/commands/team/abandon.rs. */
export function abandonSteps(items: TeamAbandonItem[]): Array<{ id: string; label: string }> {
  const t = translator('team')
  const count = (kind: TeamAbandonItem['kind']): number => items.filter((i) => i.kind === kind).length
  const identities = count('identity')
  const fabric = count('fabric')
  return [
    { id: 'check', label: t('abandon.step.check') },
    ...(identities ? [{ id: 'identity', label: t('abandon.step.identity', { count: identities }) }] : []),
    ...(count('trust') ? [{ id: 'trust', label: t('abandon.step.trust') }] : []),
    ...(fabric ? [{ id: 'fabric', label: t('abandon.step.fabric', { count: fabric }) }] : []),
    ...(count('pipeline') ? [{ id: 'cleanup', label: t('abandon.step.cleanup') }] : []),
    ...(count('github') ? [{ id: 'github', label: t('abandon.step.github') }] : []),
    { id: 'local', label: t('abandon.step.local') }
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
  const { t } = useTranslation('team')
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
          <span className="team-abandon-kind">{t(KIND_LABEL[item.kind])}</span>
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
  const { t } = useTranslation('team')
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
      next = {
        ok: false,
        error: teamError(reason, t('abandon.lookupFailed')),
        items: [],
        kept: [],
        needsDeletePermission: false
      }
    }
    setPlan(next)
    setNeedsPermission(next.needsDeletePermission)
    if (next.ok) {
      setPhase('confirm')
      return
    }
    setProblem(next.problem ?? { step: 'check', message: next.error ?? t('abandon.lookupFailed') })
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
        setGrantError(result.error ?? t('shared.signInFailed'))
        return
      }
      setWaiting(true)
    } catch (reason) {
      setGrantError(teamError(reason, t('shared.signInFailed')))
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
      result = { ok: false, error: teamError(reason, t('abandon.stoppedUnexpectedly')) }
    }
    if (result.ok) {
      onGone()
      return
    }
    if (result.workspace) setLatest(result.workspace)
    onChanged()
    const next = result.problem ?? { step: 'check', message: result.error ?? t('abandon.stopped') }
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
      setProblem({ step: 'local', message: teamError(reason, t('abandon.removeFailed')) })
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
          <h2 id={titleId}>{t('abandon.title', { name: workspace.name })}</h2>
        </div>
        <div className="modal-body team-form">
          {phase === 'checking' && (
            <div className="team-muted" role="status">
              <span className="ws-spinner" /> {t('abandon.checking')}
            </div>
          )}

          {phase === 'confirm' && plan && (
            <>
              {items.length > 0 ? (
                <>
                  <p className="team-muted">
                    {items.some((i) => i.kind === 'trust' || i.kind === 'pipeline')
                      ? t('abandon.confirmProvided')
                      : t('abandon.confirm')}
                  </p>
                  <ItemList items={items} />
                </>
              ) : (
                <p className="team-muted">{t('abandon.nothingLeft')}</p>
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
                <div className="team-muted">{t('abandon.deletePermission')}</div>
              </span>
              <button type="button" className="btn btn--sm btn--primary" onClick={() => void grant()}>
                {waiting ? t('shared.waiting') : t('shared.grantGithubAccess')}
              </button>
            </div>
          )}
          {waiting && <p className="team-muted">{t('shared.finishSignIn')}</p>}
          {grantError && <div className="alert alert--error">{grantError}</div>}

          {phase === 'failed' && (
            <p className="team-muted">
              {plan?.ok && left.length > 0
                ? t('abandon.keepsLeft', { items: left.map((i) => i.name).join(', ') })
                : plan?.ok
                  ? t('abandon.forgets')
                  : t('abandon.keepsAll')}
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
              {removing ? t('abandon.removing') : t('abandon.removeHere')}
            </button>
          )}
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={onClose}>
            {t('actions.cancel')}
          </button>
          {phase === 'failed' ? (
            <button
              key="retry"
              type="button"
              className="btn btn--primary"
              disabled={busy || (ran && needsPermission && hasRepo)}
              onClick={() => void (ran ? run() : check())}
            >
              {t('actions.tryAgain')}
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
                  {t('status.deleting')}
                </span>
              ) : deletes || phase === 'checking' ? (
                t('abandon.deleteAndAbandon')
              ) : (
                t('abandon.abandon')
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
