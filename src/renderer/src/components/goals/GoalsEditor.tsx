import {
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type JSX,
  type KeyboardEvent
} from 'react'
import type { GoalsSnapshot } from '@shared/ipc'
import type { GoalsController } from '../../goals/store'
import { pastedChecks } from '../../goals/model'
import { Codicon } from '../icons'
import { StepLog } from './StepLog'

/** `GOALS.md`'s limits (see `goals/file.rs`). */
const MAX_PURPOSE = 4000
const MAX_CHECK = 500
const MAX_CHECKS = 40

interface Line {
  key: number
  text: string
}

interface Props {
  goals: GoalsController
  snapshot: GoalsSnapshot
  /** Start with Copilot drafting them. */
  draftFirst: boolean
  /** Checks are running: saving waits until they finish. */
  runRunning: boolean
  projectPath: string
  onOpenFile: (path: string) => void
  onClose: () => void
}

/**
 * Edits an app's goals: what it's for, and its checks, one per line. Copilot
 * can draft them from the app's code, building on what's written. Saving
 * writes `GOALS.md`.
 */
export function GoalsEditor({
  goals,
  snapshot,
  draftFirst,
  runRunning,
  projectPath,
  onOpenFile,
  onClose
}: Props): JSX.Element {
  const keyRef = useRef(0)
  const line = (text: string): Line => ({ key: keyRef.current++, text })
  const [purpose, setPurpose] = useState(snapshot.purpose)
  const [lines, setLines] = useState<Line[]>(() =>
    (snapshot.checks.length ? snapshot.checks.map((c) => c.text) : ['']).map(line)
  )
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [drafted, setDrafted] = useState(false)
  const inputs = useRef(new Map<number, HTMLTextAreaElement>())
  const focusKey = useRef<number | null>(null)
  const purposeRef = useRef<HTMLTextAreaElement>(null)
  const mounted = useRef(true)
  const purposeId = useId()
  const purposeHint = useId()
  const checksLabel = useId()
  const checksHint = useId()

  const drafting = goals.draft.running
  const busy = drafting || saving
  const texts = lines.map((l) => l.text)
  const written = purpose.trim() !== '' || texts.some((t) => t.trim() !== '')

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    const key = focusKey.current
    if (key === null) return
    focusKey.current = null
    inputs.current.get(key)?.focus()
  }, [lines])

  const draft = async (): Promise<void> => {
    setSaveError(null)
    const proposal = await goals.startDraft(purpose, texts)
    if (!proposal || !mounted.current) return
    setPurpose(proposal.purpose)
    setLines((proposal.checks.length ? proposal.checks : ['']).map(line))
    setDrafted(true)
  }

  // Opened with Draft with Copilot: start it once (a ref, so a remount in development doesn't start it twice).
  const draftFirstRef = useRef(draftFirst)
  useEffect(() => {
    if (draftFirstRef.current) {
      draftFirstRef.current = false
      void draft()
    } else {
      purposeRef.current?.focus()
    }
  }, [])

  const save = async (): Promise<void> => {
    setSaving(true)
    setSaveError(null)
    try {
      await goals.save(purpose, texts)
      if (mounted.current) onClose()
    } catch (err) {
      if (mounted.current) setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  const cancel = (): void => {
    if (drafting) goals.cancelDraft()
    onClose()
  }

  const setText = (key: number, text: string): void =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, text } : l)))

  /** Add checks after the one at `index`, and focus the last of them. */
  const addAfter = (index: number, added: string[] = ['']): void => {
    const room = MAX_CHECKS - lines.length
    if (room <= 0) return
    const next = added.slice(0, room).map(line)
    focusKey.current = next[next.length - 1].key
    setLines([...lines.slice(0, index + 1), ...next, ...lines.slice(index + 1)])
  }

  /** Remove the check at `index`, and focus the one before it. */
  const remove = (index: number): void => {
    const rest = lines.filter((_, i) => i !== index)
    const next = rest.length ? rest : [line('')]
    focusKey.current = next[Math.max(0, Math.min(index - 1, next.length - 1))].key
    setLines(next)
  }

  const onCheckKey = (index: number, e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      addAfter(index)
    } else if (e.key === 'Backspace' && lines[index].text === '' && lines.length > 1) {
      e.preventDefault()
      remove(index)
    }
  }

  // A pasted list becomes a check per line.
  const onCheckPaste = (index: number, e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const items = pastedChecks(e.clipboardData.getData('text'))
    if (items.length < 2) return
    e.preventDefault()
    const current = lines[index]
    if (current.text.trim()) {
      addAfter(index, items)
      return
    }
    const [first, ...others] = items
    const next = others.slice(0, MAX_CHECKS - lines.length).map(line)
    focusKey.current = (next[next.length - 1] ?? current).key
    setLines([
      ...lines.slice(0, index),
      { ...current, text: first },
      ...next,
      ...lines.slice(index + 1)
    ])
  }

  return (
    <section className={`gl-editor${drafting ? ' is-drafting' : ''}`} aria-label="Edit goals">
      <div>
        <h2 className="gl-editor-title">
          {snapshot.purpose.trim() || snapshot.checks.length ? 'Edit goals' : 'Your app’s goals'}
        </h2>
        <p className="gl-editor-sub">Saved in your app as GOALS.md, so they travel with it.</p>
      </div>

      {runRunning && (
        <div className="adv-banner adv-banner--busy">
          <span className="step-spin" aria-hidden="true" />
          <span>The checks are running. You can save once they’re done.</span>
        </div>
      )}
      {drafting && (
        <div className="adv-banner adv-banner--busy">
          <span className="step-spin" aria-hidden="true" />
          <span>
            Copilot is reading your app to draft what it’s for and the checks it should keep
            passing…
          </span>
          <button type="button" className="adv-link" onClick={goals.cancelDraft}>
            Stop
          </button>
        </div>
      )}
      {drafting && goals.draft.activity.length > 0 && (
        <StepLog
          tools={goals.draft.activity}
          label="What Copilot is reading"
          projectPath={projectPath}
          onOpenFile={onOpenFile}
        />
      )}
      {goals.draftError && !drafting && (
        <div className="adv-banner adv-banner--error" role="alert">
          <Codicon name="error" />
          <span>{goals.draftError}</span>
          <button type="button" className="adv-link" onClick={() => void draft()}>
            Try again
          </button>
        </div>
      )}
      {drafted && !drafting && (
        <div className="adv-banner">
          <Codicon name="sparkle" />
          <span>Copilot drafted these from your app. Change anything that’s off, then save.</span>
        </div>
      )}
      {saveError && (
        <div className="adv-banner adv-banner--error" role="alert">
          <Codicon name="error" />
          <span>{saveError}</span>
        </div>
      )}

      <div className="gl-field">
        <label className="gl-label" htmlFor={purposeId}>
          What it’s for
        </label>
        <p className="gl-hint" id={purposeHint}>
          Who uses the app, and what they need it to do. Copilot reads each check in this light.
        </p>
        <textarea
          id={purposeId}
          ref={purposeRef}
          className="field-input gl-input gl-input--purpose"
          value={purpose}
          maxLength={MAX_PURPOSE}
          rows={3}
          placeholder="E.g. Field technicians log equipment inspections. Supervisors review them and sign them off."
          aria-describedby={purposeHint}
          disabled={busy}
          onChange={(e) => setPurpose(e.target.value)}
        />
      </div>

      <div className="gl-field">
        <span className="gl-label" id={checksLabel}>
          Checks
        </span>
        <p className="gl-hint" id={checksHint}>
          What the app must keep doing, one per line, the way someone using it would say it. Copilot
          proves each one by calling the app as that kind of user.
        </p>
        <ol className="gl-edit-list" aria-labelledby={checksLabel} aria-describedby={checksHint}>
          {lines.map((l, i) => (
            <li key={l.key} className="gl-edit-row">
              <span className="gl-edit-num" aria-hidden="true">
                {i + 1}
              </span>
              <textarea
                ref={(el) => {
                  if (el) inputs.current.set(l.key, el)
                  else inputs.current.delete(l.key)
                }}
                className="field-input gl-input gl-input--check"
                value={l.text}
                rows={1}
                maxLength={MAX_CHECK}
                placeholder={
                  i === 0
                    ? 'E.g. A technician can log an inspection, then see it in their list.'
                    : 'Something else the app must keep doing'
                }
                aria-label={`Check ${i + 1}`}
                disabled={busy}
                onChange={(e) => setText(l.key, e.target.value)}
                onKeyDown={(e) => onCheckKey(i, e)}
                onPaste={(e) => onCheckPaste(i, e)}
              />
              <button
                type="button"
                className="chat-tool gl-edit-remove"
                title="Remove this check"
                aria-label={`Remove check ${i + 1}`}
                disabled={busy}
                onClick={() => remove(i)}
              >
                <Codicon name="close" />
              </button>
            </li>
          ))}
        </ol>
        {lines.length < MAX_CHECKS && (
          <button
            type="button"
            className="adv-link gl-edit-add"
            disabled={busy}
            onClick={() => addAfter(lines.length - 1)}
          >
            <Codicon name="add" /> Add a check
          </button>
        )}
        <p className="gl-note">
          <Codicon name="info" />
          Rewording a check makes it a new one: it shows as not run until you run it.
        </p>
      </div>

      <div className="gl-edit-actions">
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          disabled={busy}
          title="Have Copilot read the app and propose what it’s for and its checks, building on what you’ve written"
          onClick={() => void draft()}
        >
          <Codicon name="sparkle" /> {written ? 'Improve with Copilot' : 'Draft with Copilot'}
        </button>
        <span className="gl-spacer" />
        <button type="button" className="btn btn--sm btn--ghost" disabled={saving} onClick={cancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn--sm btn--primary"
          disabled={busy || runRunning || (!written && !snapshot.exists)}
          title={runRunning ? 'Save once the checks finish' : undefined}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </section>
  )
}
