import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { GoalsSnapshot, StudioProject } from '@shared/ipc'
import { useCopilotModels } from '../../copilotModels'
import {
  checkRows,
  failedRows,
  fixPrompt,
  gapText,
  goalsGap,
  type CheckRow,
  type CheckState
} from '../../goals/model'
import type { GoalsController, GoalsRun } from '../../goals/store'
import { clock, plural, relativeTime } from '../advisor/format'
import { describeStep, stepLabel } from '../chat/toolPresentation'
import { ChevronRightIcon, Codicon } from '../icons'
import { ModelPicker } from '../models/ModelPicker'
import { GoalsEditor } from './GoalsEditor'
import { StepLog } from './StepLog'
import '../chat/chat.css'
import '../advisor/advisor.css'
import './goals.css'

interface Props {
  project: StudioProject
  goals: GoalsController
  /** The tab is showing: read the goals again, as the app may have changed. */
  visible: boolean
  /** The Build chat is mid-turn: runs and fix hand-offs wait until it's done. */
  chatBusy: boolean
  /** Hand failed checks to the Build chat for Copilot to fix. */
  onFix: (message: { display: string; prompt: string }) => void
  onOpenFile: (path: string, line?: number) => void
  /** Open Accounts at Model providers (your own API keys). */
  onManageKeys?: () => void
}

const STATE_WORD: Record<CheckState, string> = {
  passed: 'Passed',
  failed: 'Failed',
  'not-proven': 'Not proven',
  'not-run': 'Not run',
  checking: 'Checking…'
}

const RUN_WAITS = 'Copilot is changing the app in the Build chat. Run the checks once it’s done.'
const FIX_WAITS = 'Copilot is working in the Build chat. Hand this over once it’s done.'

function useNow(active: boolean, ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = window.setInterval(() => setNow(Date.now()), ms)
    return () => window.clearInterval(t)
  }, [active, ms])
  return now
}

/** What a run is doing right now, in a few words. */
function runText(run: GoalsRun, projectPath: string): string {
  if (run.stopping) return 'Stopping, and removing the app’s copy…'
  switch (run.phase) {
    case 'preparing':
      return 'Making a fresh copy of the app…'
    case 'starting':
      return 'Starting the copy…'
    case 'seeding':
      return 'Loading its seed data…'
    case 'finishing':
      return 'Removing the copy…'
  }
  const step = [...run.activity].reverse().find((t) => t.state === 'running')
  return step ? `${stepLabel(describeStep(step, projectPath))}…` : 'Checking the app…'
}

/** The checks by where they stand; out-of-date results count apart, whatever they were. */
function tally(
  rows: CheckRow[]
): Record<'passed' | 'failed' | 'notProven' | 'notRun' | 'stale', number> {
  const t = { passed: 0, failed: 0, notProven: 0, notRun: 0, stale: 0 }
  for (const row of rows) {
    if (row.state === 'checking') continue
    if (row.stale) t.stale += 1
    else if (row.state === 'passed') t.passed += 1
    else if (row.state === 'failed') t.failed += 1
    else if (row.state === 'not-proven') t.notProven += 1
    else t.notRun += 1
  }
  return t
}

/**
 * The Goals tab (an experiment): what the app is for and the checks it must
 * keep passing, from its `GOALS.md`. Copilot runs the checks on a fresh copy
 * of the app, calling it as each kind of user, and says what it found; failed
 * checks go to the Build chat to fix. Copilot can draft the goals from the code.
 */
export default function GoalsView({
  project,
  goals,
  visible,
  chatBusy,
  onFix,
  onOpenFile,
  onManageKeys
}: Props): JSX.Element {
  const [editorState, setEditor] = useState<{ projectId: string; draftFirst: boolean } | null>(null)
  const [openIds, setOpenIds] = useState<Set<string>>(new Set())
  const editor = editorState?.projectId === project.id ? editorState : null

  useEffect(() => {
    setEditor(null)
    setOpenIds(new Set())
  }, [project.id])

  // Coming back to the tab: the app may have changed since (results go out of date).
  const { reload } = goals
  const wasVisible = useRef(false)
  useEffect(() => {
    if (visible && !wasVisible.current) void reload()
    wasVisible.current = visible
  }, [visible, reload])

  const { snapshot: snap, run } = goals
  const rows = useMemo(() => checkRows(snap, run), [snap, run])
  const now = useNow(visible, run.running ? 1000 : 30_000)
  const lastModel = snap?.lastRun?.model
  const { models } = useCopilotModels(Boolean(lastModel))
  const modelName = lastModel ? (models.find((m) => m.id === lastModel)?.name ?? lastModel) : 'Auto'

  const hasGoals = Boolean(snap && (snap.purpose.trim() || snap.checks.length))
  const hasChecks = Boolean(snap?.checks.length)
  const runBlocked = !snap?.checks.length
    ? 'Add a check first'
    : (snap.cannotRun ?? (chatBusy ? RUN_WAITS : null))

  const openEditor = (draftFirst: boolean): void => setEditor({ projectId: project.id, draftFirst })
  const toggle = (id: string): void =>
    setOpenIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  let body: JSX.Element
  if (!goals.projectId) {
    body = (
      <div className="adv-empty">
        <span className="adv-empty-title">Goals aren’t available for this app</span>
      </div>
    )
  } else if (!snap && goals.loadError) {
    body = (
      <div className="adv-banner adv-banner--error" role="alert">
        <Codicon name="error" />
        <span>Couldn’t read the app’s goals: {goals.loadError}</span>
        <button type="button" className="adv-link" onClick={() => void reload()}>
          Try again
        </button>
      </div>
    )
  } else if (!snap) {
    body = (
      <div className="adv-empty">
        <span className="shimmer-text">Reading the app’s goals…</span>
      </div>
    )
  } else if (editor) {
    body = (
      <GoalsEditor
        key={project.id}
        goals={goals}
        snapshot={snap}
        draftFirst={editor.draftFirst}
        runRunning={run.running}
        projectPath={project.path}
        onOpenFile={onOpenFile}
        onClose={() => setEditor(null)}
      />
    )
  } else if (!hasGoals) {
    body = <Intro onDraft={() => openEditor(true)} onWrite={() => openEditor(false)} />
  } else {
    body = (
      <>
        {goals.runError && !run.running && (
          <div className="adv-banner adv-banner--error" role="alert">
            <Codicon name="error" />
            <span>{goals.runError}</span>
            {!runBlocked && (
              <button type="button" className="adv-link" onClick={() => goals.startRun()}>
                Try again
              </button>
            )}
            <button
              type="button"
              className="chat-tool gl-dismiss"
              title="Dismiss"
              aria-label="Dismiss"
              onClick={goals.dismissRunError}
            >
              <Codicon name="close" />
            </button>
          </div>
        )}
        {snap.cannotRun && (
          <div className="adv-banner adv-banner--warn">
            <Codicon name="warning" />
            <span>{snap.cannotRun}</span>
          </div>
        )}
        {hasChecks && (
          <StatusCard
            snapshot={snap}
            rows={rows}
            run={run}
            now={now}
            modelName={modelName}
            chatBusy={chatBusy}
            runBlocked={runBlocked}
            projectPath={project.path}
            onFix={() => onFix(fixPrompt(rows))}
            onRun={goals.startRun}
            onOpenFile={onOpenFile}
          />
        )}
        {!run.running && snap.lastRun?.summary && (
          <aside className="adv-summary">
            <div className="adv-summary-body">
              <span className="adv-summary-label">Copilot’s summary of the last run</span>
              <p>{snap.lastRun.summary}</p>
            </div>
          </aside>
        )}
        <section className="adv-card gl-goals" aria-label="Goals">
          <div className="gl-purpose">
            <span className="gl-caps">What it’s for</span>
            {snap.purpose.trim() ? (
              <p className="gl-purpose-text">{snap.purpose.trim()}</p>
            ) : (
              <p className="gl-purpose-text gl-purpose-text--empty">
                Not written yet. Say who the app is for and what they need from it, and Copilot
                reads each check in that light.
              </p>
            )}
          </div>
          <div className="adv-card-head gl-checks-head">
            <h3 className="adv-card-title">Checks</h3>
            <span className="adv-card-sub">{snap.checks.length}</span>
          </div>
          {rows.length ? (
            <ol className="gl-list">
              {rows.map((row) => (
                <CheckItem
                  key={row.check.id}
                  row={row}
                  open={openIds.has(row.check.id)}
                  now={now}
                  running={run.running}
                  runBlocked={runBlocked}
                  chatBusy={chatBusy}
                  onToggle={() => toggle(row.check.id)}
                  onRun={() => goals.startRun([row.check.id])}
                  onFix={() => onFix(fixPrompt([row]))}
                />
              ))}
            </ol>
          ) : (
            <div className="adv-empty">
              <span className="adv-empty-title">No checks yet</span>
              <p>Add what the app must keep doing, and Copilot checks it before you publish.</p>
              <div className="gl-intro-actions">
                <button
                  type="button"
                  className="btn btn--sm btn--primary"
                  onClick={() => openEditor(true)}
                >
                  <Codicon name="sparkle" /> Draft checks with Copilot
                </button>
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={() => openEditor(false)}
                >
                  <Codicon name="add" /> Add checks
                </button>
              </div>
            </div>
          )}
        </section>
      </>
    )
  }

  return (
    <div className="adv gl">
      <header className="adv-bar">
        <div className="adv-bar-title">
          <Codicon name="target" />
          <span>Goals</span>
        </div>
        {snap?.exists && (
          <button
            type="button"
            className="gl-file"
            title="Open GOALS.md in Code"
            onClick={() => onOpenFile('GOALS.md')}
          >
            <Codicon name="go-to-file" />
            GOALS.md
          </button>
        )}
        <span className="adv-bar-spacer" />
        {hasGoals && !editor && (
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            disabled={run.running}
            title={
              run.running
                ? 'Edit the goals once the checks finish'
                : 'Edit what the app is for and its checks'
            }
            onClick={() => openEditor(false)}
          >
            <Codicon name="edit" /> Edit
          </button>
        )}
        {goals.projectId && (
          <div className="adv-bar-model">
            <ModelPicker
              value={goals.selection}
              disabled={run.running || goals.draft.running}
              onChange={goals.setSelection}
              tiers
              placement="down"
              onManageKeys={onManageKeys}
              label="Goals model"
            />
          </div>
        )}
        {run.running ? (
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            disabled={run.stopping}
            onClick={goals.cancelRun}
          >
            <Codicon name="debug-stop" /> {run.stopping ? 'Stopping…' : 'Stop'}
          </button>
        ) : (
          hasChecks &&
          !editor && (
            <button
              type="button"
              className="btn btn--sm btn--primary"
              disabled={Boolean(runBlocked)}
              title={
                runBlocked ?? 'Run every check on a fresh copy of the app, as each kind of user'
              }
              onClick={() => goals.startRun()}
            >
              <Codicon name="play" /> Run checks
            </button>
          )
        )}
      </header>

      <div className="adv-scroll">
        <div className="adv-inner gl-inner">{body}</div>
      </div>
    </div>
  )
}

function Intro({ onDraft, onWrite }: { onDraft: () => void; onWrite: () => void }): JSX.Element {
  return (
    <section className="gl-intro">
      <span className="gl-intro-badge" aria-hidden="true">
        <Codicon name="target" />
      </span>
      <h2 className="gl-intro-title">Say what this app is for</h2>
      <p className="gl-intro-text">
        Write down who the app is for and what it must keep doing, in plain words. Before you
        publish, Copilot checks each one on a fresh copy of the app, using it the way each kind of
        user would, so you know a change hasn’t broken what the app is for.
      </p>
      <div className="gl-intro-actions">
        <button type="button" className="btn btn--sm btn--primary" onClick={onDraft}>
          <Codicon name="sparkle" /> Draft with Copilot
        </button>
        <button type="button" className="btn btn--sm btn--ghost" onClick={onWrite}>
          <Codicon name="edit" /> Write them myself
        </button>
      </div>
      <figure className="gl-example">
        <figcaption className="gl-caps">For example</figcaption>
        <p>
          Field technicians log equipment inspections. Supervisors review them and sign them off.
        </p>
        <ol>
          <li>A technician can log an inspection, then find it in their list.</li>
          <li>A technician can’t see or change another technician’s inspections.</li>
          <li>
            A supervisor can sign off an inspection, and its technician sees that it’s signed off.
          </li>
        </ol>
      </figure>
    </section>
  )
}

function StatusCard({
  snapshot,
  rows,
  run,
  now,
  modelName,
  chatBusy,
  runBlocked,
  projectPath,
  onFix,
  onRun,
  onOpenFile
}: {
  snapshot: GoalsSnapshot
  rows: CheckRow[]
  run: GoalsRun
  now: number
  modelName: string
  chatBusy: boolean
  /** Why runs can't start now, when they can't. */
  runBlocked: string | null
  projectPath: string
  onFix: () => void
  onRun: (checkIds: string[]) => void
  onOpenFile: (path: string) => void
}): JSX.Element {
  const failed = run.running ? [] : failedRows(rows)
  const counts = tally(rows)
  const last = snapshot.lastRun
  const gap = run.running ? null : goalsGap(snapshot)
  // The checks with no result on the app as it is now, when that's some of them (for all, Run checks).
  const rest = gap && gap.unchecked.length < snapshot.checks.length ? gap.unchecked : []
  let tone: 'ok' | 'bad' | 'warn' | 'running' | 'idle' = 'idle'
  let title: string
  let sub: string | null = null

  if (run.running) {
    tone = 'running'
    const ids = run.checkIds
    const done = ids
      ? run.results.filter((r) => ids.includes(r.checkId)).length
      : run.results.length
    title = ids ? `Running ${plural(ids.length, 'check')}` : 'Running the checks'
    sub = ids ? `${done} of ${ids.length} done` : `${done} done so far`
    if (!run.adopted) sub += ` · ${clock(now - run.startedAt)}`
  } else {
    if (snapshot.cannotRun) {
      title = 'The checks can’t run for this app'
    } else if (snapshot.allPassed) {
      tone = 'ok'
      title =
        snapshot.checks.length === 1
          ? 'The check passed'
          : `All ${snapshot.checks.length} checks passed`
    } else if (!last && !snapshot.results.length) {
      title = 'Not checked yet'
      sub = 'Run the checks to see whether the app does what it’s for.'
    } else if (gap) {
      tone = gap.failed ? 'bad' : 'warn'
      title = gapText(gap)
    } else {
      title = 'Not checked yet'
    }
    if (last && !sub) {
      const parts = [
        `Last run ${relativeTime(last.ranAt, now)}`,
        `took ${clock(last.durationMs)}`,
        `on ${modelName}`
      ]
      if (!last.all) parts.push(`ran ${plural(last.checkIds.length, 'check')}`)
      if (!last.complete) parts.push('stopped early')
      sub = parts.join(' · ')
    }
  }

  return (
    <section className={`gl-status gl-status--${tone}`} aria-label="Where the checks stand">
      <div className="gl-status-head">
        <span className="gl-status-dot" aria-hidden="true" />
        <div className="gl-status-text">
          <h2 className="gl-status-title" aria-live="polite">
            {title}
          </h2>
          {sub && <p className="gl-status-sub">{sub}</p>}
        </div>
        {(rest.length > 0 || failed.length > 0) && (
          <div className="gl-status-side">
            {rest.length > 0 && (
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                disabled={Boolean(runBlocked)}
                title={runBlocked ?? 'Run only the checks that haven’t run on the app as it is now'}
                onClick={() => onRun(rest)}
              >
                <Codicon name="play" /> Run {plural(rest.length, 'check')}
              </button>
            )}
            {failed.length > 0 && (
              <button
                type="button"
                className="btn btn--sm btn--primary"
                disabled={chatBusy}
                title={chatBusy ? FIX_WAITS : 'Hand the failed checks to Copilot in the Build chat'}
                onClick={onFix}
              >
                <Codicon name="sparkle" />{' '}
                {failed.length === 1 ? 'Fix with Copilot' : `Fix ${failed.length} with Copilot`}
              </button>
            )}
          </div>
        )}
      </div>
      {run.running ? (
        <>
          <p className="adv-live gl-live">
            <span className="step-spin" aria-hidden="true" />
            <span className="adv-live-text shimmer-text">{runText(run, projectPath)}</span>
          </p>
          {run.activity.length > 0 && (
            <StepLog
              tools={run.activity}
              label="What Copilot is doing"
              projectPath={projectPath}
              onOpenFile={onOpenFile}
            />
          )}
        </>
      ) : (
        rows.some((r) => r.result) && (
          <div className="gl-chips">
            {counts.passed > 0 && (
              <span className="adv-chip gl-chip--passed">{counts.passed} passed</span>
            )}
            {counts.failed > 0 && (
              <span className="adv-chip gl-chip--failed">{counts.failed} failed</span>
            )}
            {counts.notProven > 0 && (
              <span className="adv-chip gl-chip--not-proven">{counts.notProven} not proven</span>
            )}
            {counts.stale > 0 && (
              <span className="adv-chip gl-chip--stale">{counts.stale} out of date</span>
            )}
            {counts.notRun > 0 && (
              <span className="adv-chip gl-chip--not-run">{counts.notRun} not run</span>
            )}
          </div>
        )
      )}
    </section>
  )
}

function CheckItem({
  row,
  open,
  now,
  running,
  runBlocked,
  chatBusy,
  onToggle,
  onRun,
  onFix
}: {
  row: CheckRow
  open: boolean
  now: number
  running: boolean
  runBlocked: string | null
  chatBusy: boolean
  onToggle: () => void
  onRun: () => void
  onFix: () => void
}): JSX.Element {
  const { check, result, state } = row
  const checking = state === 'checking'
  const stale = row.stale && !checking
  const bodyId = `gl-check-${check.id}`
  const fixable = failedRows([row]).length > 0
  return (
    <li
      className={`gl-check gl-check--${state}${stale ? ' is-stale' : ''}${open ? ' is-open' : ''}`}
    >
      <button
        type="button"
        className="gl-check-btn"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={onToggle}
      >
        <span className="gl-check-mark" aria-hidden="true">
          {checking ? <span className="step-spin" /> : <span className="gl-dot" />}
        </span>
        <span className="gl-check-main">
          <span className="gl-check-text">{check.text}</span>
          {result?.summary && !checking && (
            <span className="gl-check-summary">{result.summary}</span>
          )}
        </span>
        <span className="gl-check-side">
          {stale && <span className="adv-status adv-status--muted">Out of date</span>}
          <span className="gl-check-state">{STATE_WORD[state]}</span>
          <ChevronRightIcon className="gl-check-caret" />
        </span>
      </button>
      {open && (
        <div className="gl-check-body" id={bodyId}>
          {checking ? (
            <p className="gl-check-note">Copilot is checking this now.</p>
          ) : !result ? (
            <p className="gl-check-note">Not run yet. Run it to see whether the app does this.</p>
          ) : (
            <>
              {state === 'not-proven' && (
                <p className="gl-check-note">
                  Copilot couldn’t show this either way by using the app. Make the check more
                  specific, or make sure the app’s seed data and roles let someone do it.
                </p>
              )}
              {result.evidence.length > 0 && (
                <div className="gl-section">
                  <h4 className="gl-caps">What Copilot found</h4>
                  <ul className="gl-evidence">
                    {result.evidence.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                </div>
              )}
              {result.calls.length > 0 && (
                <div className="gl-section">
                  <h4 className="gl-caps">Calls it made</h4>
                  <ul className="gl-calls">
                    {result.calls.map((call, i) => (
                      <li key={i}>{call}</li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="gl-check-when">
                Checked {relativeTime(result.ranAt, now)}
                {stale ? ', before the app’s latest changes' : ''}.
              </p>
            </>
          )}
          <div className="adv-detail-actions">
            {fixable && (
              <button
                type="button"
                className="btn btn--sm btn--primary"
                disabled={chatBusy}
                title={chatBusy ? FIX_WAITS : 'Hand this check to Copilot in the Build chat'}
                onClick={onFix}
              >
                <Codicon name="sparkle" /> Fix with Copilot
              </button>
            )}
            <span className="adv-detail-actions-spacer" />
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              disabled={running || Boolean(runBlocked)}
              title={
                running
                  ? 'The checks are running'
                  : (runBlocked ?? 'Run just this check on a fresh copy of the app')
              }
              onClick={onRun}
            >
              <Codicon name="play" /> Run this check
            </button>
          </div>
        </div>
      )}
    </li>
  )
}
