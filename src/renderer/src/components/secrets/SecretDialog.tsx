import { useEffect, useId, useState, type JSX } from 'react'
import type { SecretInfo } from '@shared/ipc'
import { useModalFocus } from '../../modalFocus'
import { useSuppressPreview } from '../../overlay'
import { Codicon } from '../icons'

/** Rayfin's secret names: what functions write after `ctx.Secrets.` */
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/

/** Typed text as a secret name, in the usual UPPER_SNAKE_CASE ("openai key" → "OPENAI_KEY"). */
export function toSecretName(text: string): string {
  return text
    .toUpperCase()
    .replace(/[\s.-]+/g, '_')
    .replace(/[^A-Z0-9_]/g, '')
    .slice(0, 128)
}

/** Why a name won't do, or null. */
export function nameProblem(name: string): string | null {
  if (!name) return null
  return NAME_RE.test(name) ? null : 'Start the name with a letter.'
}

interface Props {
  projectId: string
  /** The secret whose value to set; absent to add a new one. */
  replacing?: SecretInfo | null
  /** Secrets the app already has, to say when a name replaces one. */
  existing: SecretInfo[]
  onClose: () => void
  /** The value was stored. `added` is false when an existing secret got a new value. */
  onSaved: (name: string, added: boolean) => void
}

/**
 * Add a secret, or set a secret's value. The value goes straight to the Rayfin
 * CLI (`rayfin secret set --stdin`) and is never stored by Fabricator; it lives
 * only in this dialog until it's sent.
 */
export default function SecretDialog({ projectId, replacing, existing, onClose, onSaved }: Props): JSX.Element {
  useSuppressPreview()
  const dialogRef = useModalFocus<HTMLDivElement>()
  const titleId = useId()
  const nameId = useId()
  const valueId = useId()
  const describeId = useId()
  const [name, setName] = useState(replacing?.name ?? '')
  const [value, setValue] = useState('')
  const [description, setDescription] = useState('')
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [signIn, setSignIn] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const problem = replacing ? null : nameProblem(name)
  const match = replacing ?? existing.find((s) => s.name === name) ?? null
  const canSave = Boolean(name) && !problem && value.trim().length > 0 && !busy
  const action = match?.stored ? 'Replace value' : match ? 'Set value' : 'Add secret'

  const save = async (): Promise<void> => {
    if (!canSave) return
    setBusy(true)
    setError(null)
    setSignIn(false)
    try {
      const result = await window.api.secrets.set(
        projectId,
        name,
        value,
        match?.declared ? undefined : description.trim() || undefined
      )
      if (result.ok) {
        setValue('')
        onSaved(name, !match)
        onClose()
        return
      }
      setError(result.error ?? 'Couldn’t save the secret.')
      setSignIn(Boolean(result.signIn))
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div
        className="modal sec-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h2 id={titleId}>{replacing ? action : 'New secret'}</h2>
            <p className="modal-sub">
              {replacing
                ? `A new value for ${replacing.name}. Functions get it from their next run.`
                : 'An API key, password or connection string your functions need.'}
            </p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close" disabled={busy}>
            ✕
          </button>
        </div>

        <form
          className="sec-form"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <div className="modal-body sec-body">
            {error && (
              <div className="alert alert--error" role="alert">
                {error}
                {signIn &&
                  ' Your Fabric sign-in may have expired: open the account menu and select Refresh Fabric authentication.'}
              </div>
            )}

            {!replacing && (
              <div className="sec-field">
                <label htmlFor={nameId}>Name</label>
                <input
                  id={nameId}
                  className="field-input sec-mono"
                  value={name}
                  onChange={(e) => setName(toSecretName(e.target.value))}
                  placeholder="OPENAI_API_KEY"
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                  disabled={busy}
                  aria-invalid={Boolean(problem)}
                  aria-describedby={`${nameId}-hint`}
                />
                <span id={`${nameId}-hint`} className={`sec-hint${problem ? ' sec-hint--error' : ''}`}>
                  {problem ??
                    (match
                      ? `This app already has ${match.name}. Saving replaces its value.`
                      : 'Letters, numbers and underscores. Functions read it by this name.')}
                </span>
              </div>
            )}

            <div className="sec-field">
              <label htmlFor={valueId}>Value</label>
              <div className="sec-value">
                <input
                  id={valueId}
                  className="field-input sec-mono"
                  type={reveal ? 'text' : 'password'}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  autoComplete="new-password"
                  spellCheck={false}
                  autoFocus={Boolean(replacing)}
                  disabled={busy}
                  aria-describedby={`${valueId}-hint`}
                />
                <button
                  type="button"
                  className="sec-reveal"
                  onClick={() => setReveal((r) => !r)}
                  aria-label={reveal ? 'Hide value' : 'Show value'}
                  aria-pressed={reveal}
                  title={reveal ? 'Hide value' : 'Show value'}
                >
                  <Codicon name={reveal ? 'eye-closed' : 'eye'} />
                </button>
              </div>
              <span id={`${valueId}-hint`} className="sec-hint">
                Sent straight to your deployed app. Fabricator doesn’t keep it, and nobody can read it back.
              </span>
            </div>

            {!match?.declared && (
              <div className="sec-field">
                <label htmlFor={describeId}>
                  What it’s for <span className="sec-optional">(optional)</span>
                </label>
                <input
                  id={describeId}
                  className="field-input"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Key for the chat function"
                  maxLength={200}
                  disabled={busy}
                  aria-describedby={`${describeId}-hint`}
                />
                <span id={`${describeId}-hint`} className="sec-hint">
                  Saved with the name in <code>rayfin/rayfin.yml</code>. Never put the value here.
                </span>
              </div>
            )}
          </div>

          <div className="modal-footer">
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="btn btn--primary" disabled={!canSave}>
              {busy ? (
                <span className="btn-busy">
                  <span className="btn-spin" aria-hidden="true" />
                  Saving…
                </span>
              ) : (
                action
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
