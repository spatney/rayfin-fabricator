import { useEffect, useId, useState, type JSX } from 'react'
import type { SecretInfo } from '@shared/ipc'
import { Trans, translator, useTranslation } from '../../i18n'
import { toLocalBackendError } from '../../localBackend'
import { useModalFocus } from '../../modalFocus'
import { useSuppressPreview } from '../../overlay'
import { Codicon } from '../icons'
import type { SecretEntry } from './entries'

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
  return NAME_RE.test(name) ? null : translator('secrets')('dialog.nameProblem')
}

/** What the dialog sets. */
export type SecretDialogTarget =
  /** A new secret: added to `rayfin.yml`, with its value on this computer. */
  | { kind: 'new' }
  /** A secret's value on this computer. `replacing`: it has one now. */
  | { kind: 'local'; name: string; replacing: boolean }
  /** A secret's value on the published app. */
  | { kind: 'published'; secret: SecretInfo }

/** What was saved: a new secret, a value on this computer, or one on the published app. */
export type SecretSaved = 'added' | 'local' | 'published'

interface Props {
  projectId: string
  target: SecretDialogTarget
  /** The app's secrets, to say when a new name is one of them. */
  existing: SecretEntry[]
  onClose: () => void
  /** The value was stored. */
  onSaved: (name: string, saved: SecretSaved) => void
  /** A new secret went into `rayfin.yml`, though its value wasn't stored yet. */
  onDeclared?: (name: string) => void
}

/** A failed call's message, with its hint when there is one. */
function failure(reason: unknown): string {
  const error = toLocalBackendError(reason)
  return error.hint ? `${error.message} ${error.hint}` : error.message
}

/**
 * Add a secret, or set a secret's value on this computer or on the published
 * app. A value on this computer goes to rayfin-local (`rayfin-local secret
 * set`), one for the published app to the Rayfin CLI (`rayfin secret set
 * --stdin`); either way through stdin, and Fabricator keeps no copy. The value
 * lives only in this dialog until it's sent.
 */
export default function SecretDialog({
  projectId,
  target,
  existing,
  onClose,
  onSaved,
  onDeclared
}: Props): JSX.Element {
  const { t } = useTranslation('secrets')
  useSuppressPreview()
  const dialogRef = useModalFocus<HTMLDivElement>()
  const titleId = useId()
  const nameId = useId()
  const valueId = useId()
  const describeId = useId()
  const fixedName =
    target.kind === 'local' ? target.name : target.kind === 'published' ? target.secret.name : null
  const [name, setName] = useState(fixedName ?? '')
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

  const problem = fixedName ? null : nameProblem(name)
  const match = target.kind === 'new' ? (existing.find((s) => s.name === name) ?? null) : null
  const declared =
    target.kind === 'published'
      ? target.secret.declared
      : target.kind === 'local' || Boolean(match?.declared)
  const canSave = Boolean(name) && !problem && value.trim().length > 0 && !busy

  let title: string
  let subtitle: string
  let action: string
  let valueHint = t('dialog.localHint')
  if (target.kind === 'published') {
    const stored = target.secret.stored
    title = stored ? t('dialog.replacePublishedTitle') : t('dialog.setPublishedTitle')
    subtitle = t('dialog.publishedSubtitle', { name })
    action = stored ? t('dialog.replaceValue') : t('dialog.setValue')
    valueHint = t('dialog.publishedHint')
  } else if (target.kind === 'local') {
    title = target.replacing ? t('dialog.changeLocalTitle') : t('dialog.setLocalTitle')
    subtitle = t('dialog.localSubtitle', { name })
    action = target.replacing ? t('dialog.changeValue') : t('dialog.setValue')
  } else {
    title = t('dialog.newTitle')
    subtitle = t('dialog.newSubtitle')
    action = match?.declared ? t('dialog.setValue') : t('dialog.add')
  }

  const save = async (): Promise<void> => {
    if (!canSave) return
    setBusy(true)
    setError(null)
    setSignIn(false)
    try {
      let saved: SecretSaved
      if (target.kind === 'published') {
        const result = await window.api.secrets.set(
          projectId,
          name,
          value,
          declared ? undefined : description.trim() || undefined
        )
        if (!result.ok) {
          setError(result.error ?? t('dialog.saveFailed'))
          setSignIn(Boolean(result.signIn))
          return
        }
        saved = 'published'
      } else {
        saved = 'local'
        if (!declared) {
          const result = await window.api.secrets.declare(
            projectId,
            name,
            description.trim() || undefined
          )
          if (!result.ok) {
            setError(result.error ?? t('dialog.addFailed'))
            return
          }
          onDeclared?.(name)
          saved = 'added'
        }
        await window.api.local.setSecret(projectId, name, value)
      }
      setValue('')
      onSaved(name, saved)
      onClose()
    } catch (err) {
      setError(failure(err))
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
            <h2 id={titleId}>{title}</h2>
            <p className="modal-sub">{subtitle}</p>
          </div>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label={t('actions.close')}
            disabled={busy}
          >
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
                {signIn && ` ${t('dialog.signInHint')}`}
              </div>
            )}

            {!fixedName && (
              <div className="sec-field">
                <label htmlFor={nameId}>{t('dialog.name')}</label>
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
                <span
                  id={`${nameId}-hint`}
                  className={`sec-hint${problem ? ' sec-hint--error' : ''}`}
                >
                  {problem ??
                    (match
                      ? match.declared
                        ? t('dialog.existing', { name: match.name })
                        : t('dialog.undeclared', { name: match.name })
                      : t('dialog.nameHint'))}
                </span>
              </div>
            )}

            <div className="sec-field">
              <label htmlFor={valueId}>{t('dialog.value')}</label>
              <div className="sec-value">
                <input
                  id={valueId}
                  className="field-input sec-mono"
                  type={reveal ? 'text' : 'password'}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  autoComplete="new-password"
                  spellCheck={false}
                  autoFocus={Boolean(fixedName)}
                  disabled={busy}
                  aria-describedby={`${valueId}-hint`}
                />
                <button
                  type="button"
                  className="sec-reveal"
                  onClick={() => setReveal((r) => !r)}
                  aria-label={reveal ? t('dialog.hideValue') : t('dialog.showValue')}
                  aria-pressed={reveal}
                  title={reveal ? t('dialog.hideValue') : t('dialog.showValue')}
                >
                  <Codicon name={reveal ? 'eye-closed' : 'eye'} />
                </button>
              </div>
              <span id={`${valueId}-hint`} className="sec-hint">
                {valueHint}
              </span>
            </div>

            {!declared && (
              <div className="sec-field">
                <label htmlFor={describeId}>
                  {t('dialog.purpose')} <span className="sec-optional">{t('dialog.optional')}</span>
                </label>
                <input
                  id={describeId}
                  className="field-input"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t('dialog.purposePlaceholder')}
                  maxLength={200}
                  disabled={busy}
                  aria-describedby={`${describeId}-hint`}
                />
                <span id={`${describeId}-hint`} className="sec-hint">
                  <Trans t={t} i18nKey="dialog.purposeHint" components={{ code: <code /> }} />
                </span>
              </div>
            )}
          </div>

          <div className="modal-footer">
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
              {t('actions.cancel')}
            </button>
            <button type="submit" className="btn btn--primary" disabled={!canSave}>
              {busy ? (
                <span className="btn-busy">
                  <span className="btn-spin" aria-hidden="true" />
                  {t('status.saving')}
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
