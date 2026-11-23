import { useEffect, useId, useRef, useState, type JSX } from 'react'
import type { SecretInfo } from '@shared/ipc'
import { openDocs } from '../../docsLinks'
import { Trans, formatLocale, translator, useTranslation } from '../../i18n'
import { relativeTime } from '../advisor/format'
import { Codicon } from '../icons'
import type { LocalSource, SecretEntry } from './entries'

/** A secret's state as a small dot and a word (the Skills tab's status styles). */
export function SecretStatus({ secret }: { secret: SecretInfo }): JSX.Element {
  const { t } = useTranslation('secrets')
  const [tone, label] = !secret.stored
    ? ['update', t('values.noValue')]
    : secret.declared
      ? ['on', t('values.set')]
      : ['off', t('notInYml')]
  return (
    <span className={`skl-status skl-status--${tone}`}>
      <span className="skl-status-dot" aria-hidden="true" />
      {label}
    </span>
  )
}

/** A value's state: a tone for its dot, and a word. */
export interface ValueState {
  tone: 'on' | 'update' | 'off'
  label: string
}

/** A {@link ValueState} as a small dot and a word. */
export function ValueStatus({ state }: { state: ValueState }): JSX.Element {
  return (
    <span className={`skl-status skl-status--${state.tone}`}>
      <span className="skl-status-dot" aria-hidden="true" />
      {state.label}
    </span>
  )
}

/** Reading a set of values: still reading, read, or couldn't. */
export type Check = 'loading' | 'ok' | 'failed'

const LOCAL = {
  none: { tone: 'update', label: 'values.notSet' },
  local: { tone: 'on', label: 'values.setHere' },
  env: { tone: 'on', label: 'values.fromEnv' },
  settings: { tone: 'on', label: 'values.fromSettings' }
} as const satisfies Record<LocalSource, { tone: ValueState['tone']; label: string }>

/** Where a value on this computer comes from, as a {@link ValueState}. */
function localState(source: LocalSource): ValueState {
  const { tone, label } = LOCAL[source]
  return { tone, label: translator('secrets')(label) }
}

/** A value that couldn't be checked. */
function unknownState(): ValueState {
  return { tone: 'off', label: translator('secrets')('values.unknown') }
}

/** A secret's value on this computer, or `null` when there's nothing to say. */
export function localValueState(entry: SecretEntry, check: Check): ValueState | null {
  if (!entry.local) return check === 'failed' ? unknownState() : null
  if (entry.declared) return localState(entry.local)
  // Functions don't get a secret rayfin.yml doesn't list: its value isn't used.
  return entry.local === 'none' ? null : { ...localState(entry.local), tone: 'off' }
}

/** A secret's value on the published app, or `null` when there's nothing to say. */
export function publishedValueState(entry: SecretEntry, check: Check): ValueState | null {
  if (check === 'failed') return unknownState()
  if (check === 'loading') return null
  const t = translator('secrets')
  if (entry.published?.stored)
    return { tone: entry.declared ? 'on' : 'off', label: t('values.set') }
  return entry.declared ? { tone: 'update', label: t('values.notSet') } : null
}

/** How a function reads the secret. */
export function readExpression(name: string): string {
  return `ctx.Secrets.${name}`
}

/** A chat prompt that hands the secret (its name, never its value) to Copilot. */
export function copilotPrompt(name: string, declared: boolean): string {
  return [
    `This app has a function secret named ${name}. Its value is kept out of the code, and Rayfin functions read it as \`${readExpression(name)}\` (see the rayfin-functions skill).`,
    ...(declared
      ? []
      : [
          `rayfin/rayfin.yml doesn't list it yet: add { name: ${name}, description } to its \`secrets:\` list first, so functions can read it by name.`
        ]),
    'Only read it inside a Rayfin function. Never hard-code its value, log it, or send it to the browser.',
    '',
    'What I’d like you to do: '
  ].join('\n')
}

function CopyCode({ text }: { text: string }): JSX.Element {
  const { t } = useTranslation('secrets')
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current)
    },
    []
  )
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      if (timer.current != null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1200)
    } catch {
      /* clipboard unavailable */
    }
  }
  return (
    <div className="sec-code">
      <code>{text}</code>
      <button
        type="button"
        className="skl-icon-btn"
        onClick={() => void copy()}
        aria-label={copied ? t('actions.copied') : t('details.copyCode', { code: text })}
        title={copied ? t('actions.copied') : t('actions.copy')}
      >
        <Codicon name={copied ? 'check' : 'copy'} />
      </button>
    </div>
  )
}

/** The close button and the heading of a secret's details. */
function DetailsHead({
  name,
  kicker,
  status,
  onClose
}: {
  name: string
  kicker: string
  status?: JSX.Element | null
  onClose: () => void
}): JSX.Element {
  const { t } = useTranslation('secrets')
  return (
    <>
      <button
        type="button"
        className="skl-icon-btn skl-side-close"
        onClick={onClose}
        aria-label={t('details.closeDetails')}
        title={t('details.closeEsc')}
      >
        <Codicon name="close" />
      </button>

      <header className="skl-insp-head">
        <span className="sec-mark sec-mark--lg" aria-hidden="true">
          <Codicon name="key" />
        </span>
        <div className="skl-titles">
          <span className="skl-kicker">{kicker}</span>
          <h3 className="sec-name">{name}</h3>
          {status}
        </div>
      </header>
    </>
  )
}

/** When a stored value changed and was added. */
function ValueDates({ secret }: { secret: SecretInfo }): JSX.Element | null {
  const { t } = useTranslation('secrets')
  if (!secret.updatedAt && !secret.createdAt) return null
  const now = Date.now()
  return (
    <ul className="skl-facts">
      {secret.updatedAt && (
        <li>
          <span>{t('details.changed')}</span>
          <span title={new Date(secret.updatedAt).toLocaleString(formatLocale())}>
            {relativeTime(secret.updatedAt, now)}
          </span>
        </li>
      )}
      {secret.createdAt && (
        <li>
          <span>{t('details.added')}</span>
          <span title={new Date(secret.createdAt).toLocaleString(formatLocale())}>
            {relativeTime(secret.createdAt, now)}
          </span>
        </li>
      )}
    </ul>
  )
}

/** How a function reads the secret, and a way to hand it to Copilot. */
function UseInFunction({
  name,
  onAskCopilot
}: {
  name: string
  onAskCopilot?: () => void
}): JSX.Element {
  const { t } = useTranslation('secrets')
  return (
    <section className="skl-section-block">
      <h4>{t('details.useTitle')}</h4>
      <CopyCode text={readExpression(name)} />
      <p className="skl-text">{t('details.useHint')}</p>
      {onAskCopilot && (
        <button type="button" className="skl-link" onClick={onAskCopilot}>
          <Codicon name="copilot" /> {t('details.askCopilot')}
        </button>
      )}
    </section>
  )
}

interface DetailsProps {
  secret: SecretInfo
  /** Where the secret lives ("Published app", "Your preview"). */
  environment?: string
  /** The app in the Fabric portal, where its secrets are changed. */
  portalUrl?: string
  onClose: () => void
  onAskCopilot?: (secret: SecretInfo) => void
}

/** A team app's secret, read-only: its state, how functions read it, and where to change it. */
export function SecretDetails({
  secret,
  environment,
  portalUrl,
  onClose,
  onAskCopilot
}: DetailsProps): JSX.Element {
  const { t } = useTranslation('secrets')
  return (
    <aside
      className="skl-side skl-side--detail"
      aria-label={t('details.label', { name: secret.name })}
    >
      <DetailsHead
        name={secret.name}
        kicker={environment ? t('details.kickerIn', { environment }) : t('details.kicker')}
        status={<SecretStatus secret={secret} />}
        onClose={onClose}
      />

      {secret.description && <p className="skl-text">{secret.description}</p>}

      {!secret.stored && <p className="sec-warn">{t('details.noValueTeam')}</p>}
      {secret.stored && !secret.declared && (
        <p className="skl-note">
          <Codicon name="info" />
          <span>
            <Trans t={t} i18nKey="details.undeclaredTeam" components={{ code: <code /> }} />
          </span>
        </p>
      )}

      <section className="skl-section-block">
        <h4>{t('details.value')}</h4>
        <ValueDates secret={secret} />
        <p className="skl-hint">{secret.stored ? t('details.hidden') : t('details.notSetYet')}</p>
      </section>

      <UseInFunction
        name={secret.name}
        onAskCopilot={onAskCopilot ? () => onAskCopilot(secret) : undefined}
      />

      {portalUrl && (
        <div className="skl-actions">
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void window.api.openExternal(portalUrl)}
          >
            {t('openInFabric')} <Codicon name="link-external" />
          </button>
        </div>
      )}
    </aside>
  )
}

interface EntryDetailsProps {
  entry: SecretEntry
  /** Reading the values on this computer; `null` for an app that has none here. */
  localCheck: Check | null
  /** Reading the published app's values; `null` while the app isn't published. */
  publishedCheck: Check | null
  /** The published values are being read again, so their actions wait. */
  busy: boolean
  onClose: () => void
  onSetLocal: (entry: SecretEntry) => void
  onRemoveLocal: (entry: SecretEntry) => void
  onSetPublished: (entry: SecretEntry) => void
  onDeletePublished: (entry: SecretEntry) => void
  onAskCopilot?: (entry: SecretEntry) => void
}

/** What a secret's value on this computer means. */
function LocalHint({ entry, check }: { entry: SecretEntry; check: Check }): JSX.Element | null {
  const { t } = useTranslation('secrets')
  const code = { code: <code /> }
  switch (entry.local) {
    case undefined:
      return (
        <p className="skl-hint">
          {check === 'failed' ? t('details.couldntCheck') : t('status.checking')}
        </p>
      )
    case 'none':
      return entry.declared ? <p className="sec-warn">{t('details.localMissing')}</p> : null
    case 'local':
      return (
        <p className="skl-hint">
          <Trans
            t={t}
            i18nKey={entry.declared ? 'details.localSavedDeclared' : 'details.localSaved'}
            components={code}
          />
        </p>
      )
    case 'env':
      return (
        <p className="skl-hint">
          <Trans t={t} i18nKey="details.localEnv" values={{ name: entry.name }} components={code} />
        </p>
      )
    case 'settings':
      return (
        <p className="skl-hint">
          <Trans t={t} i18nKey="details.localSettings" components={code} />
        </p>
      )
  }
}

/**
 * One of the app's secrets: its value on this computer, its value on the
 * published app once there is one, and how functions read it.
 */
export function EntryDetails({
  entry,
  localCheck,
  publishedCheck,
  busy,
  onClose,
  onSetLocal,
  onRemoveLocal,
  onSetPublished,
  onDeletePublished,
  onAskCopilot
}: EntryDetailsProps): JSX.Element {
  const { t } = useTranslation('secrets')
  const localId = useId()
  const publishedId = useId()
  // An unused secret without a value here still says so, like its published value.
  const local = localCheck
    ? (localValueState(entry, localCheck) ??
      (entry.local === 'none' ? { tone: 'off' as const, label: t('values.notSet') } : null))
    : null
  const published = entry.published
  const stored = Boolean(published?.stored)
  // The environment's value always wins, so one set here wouldn't be used.
  const canSetLocal =
    Boolean(localCheck) && entry.declared && entry.local !== 'env' && localCheck !== 'loading'
  const hasLocal = entry.local === 'local' || entry.local === 'settings'

  return (
    <aside
      className="skl-side skl-side--detail"
      aria-label={t('details.label', { name: entry.name })}
    >
      <DetailsHead
        name={entry.name}
        kicker={t('details.kicker')}
        status={
          entry.declared ? null : <ValueStatus state={{ tone: 'off', label: t('notInYml') }} />
        }
        onClose={onClose}
      />

      {entry.description && <p className="skl-text">{entry.description}</p>}

      {!entry.declared && (
        <p className="skl-note">
          <Codicon name="info" />
          <span>
            <Trans
              t={t}
              i18nKey={stored ? 'details.undeclaredStored' : 'details.undeclaredLocal'}
              components={{ code: <code /> }}
            />
          </span>
        </p>
      )}

      {localCheck && (
        <section className="skl-section-block" aria-labelledby={localId}>
          <h4 id={localId}>{t('values.local')}</h4>
          {local && <ValueStatus state={local} />}
          <LocalHint entry={entry} check={localCheck} />
          {(canSetLocal || entry.local === 'local') && (
            <div className="sec-actions">
              {canSetLocal && (
                <button type="button" className="btn btn--sm" onClick={() => onSetLocal(entry)}>
                  <Codicon name="edit" /> {hasLocal ? t('details.change') : t('details.set')}
                </button>
              )}
              {entry.local === 'local' && (
                <button
                  type="button"
                  className="btn btn--sm skl-danger"
                  onClick={() => onRemoveLocal(entry)}
                >
                  <Codicon name="trash" /> {t('actions.remove')}
                </button>
              )}
            </div>
          )}
        </section>
      )}

      <section className="skl-section-block" aria-labelledby={publishedId}>
        <h4 id={publishedId}>{t('values.published')}</h4>
        {publishedCheck === null ? (
          <p className="skl-hint">{t('details.publishLater')}</p>
        ) : publishedCheck === 'failed' ? (
          <p className="skl-hint">{t('details.publishedFailed')}</p>
        ) : publishedCheck === 'loading' ? (
          <p className="skl-hint">{t('status.checking')}</p>
        ) : (
          <>
            <ValueStatus
              state={publishedValueState(entry, 'ok') ?? { tone: 'off', label: t('values.notSet') }}
            />
            {published && <ValueDates secret={published} />}
            {stored ? (
              <p className="skl-hint">{t('details.hidden')}</p>
            ) : (
              entry.declared && <p className="sec-warn">{t('details.publishedMissing')}</p>
            )}
            {(entry.declared || stored) && (
              <div className="sec-actions">
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={busy}
                  onClick={() => onSetPublished(entry)}
                >
                  <Codicon name="edit" /> {stored ? t('dialog.replaceValue') : t('dialog.setValue')}
                </button>
                {stored && (
                  <button
                    type="button"
                    className="btn btn--sm skl-danger"
                    disabled={busy}
                    onClick={() => onDeletePublished(entry)}
                  >
                    <Codicon name="trash" /> {t('actions.delete')}
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </section>

      <UseInFunction
        name={entry.name}
        onAskCopilot={onAskCopilot ? () => onAskCopilot(entry) : undefined}
      />
    </aside>
  )
}

/** The side panel while nothing is selected: how secrets work and what this app has. */
export function SecretsOverview({
  facts,
  functionsEnabled,
  team,
  published = false
}: {
  /** Figures for "In this app", as (label, value). */
  facts: [string, string][]
  functionsEnabled: boolean
  /** A team app: its deployments' secrets are changed in the Fabric portal. */
  team: boolean
  /** A personal app that has been published, so it has published values too. */
  published?: boolean
}): JSX.Element {
  const { t } = useTranslation('secrets')
  return (
    <aside className="skl-side skl-side--overview" aria-label={t('overview.label')}>
      <section className="skl-section-block">
        <h4>{t('overview.how')}</h4>
        <ol className="skl-how">
          <li>{t('overview.step1')}</li>
          <li>
            <Trans
              t={t}
              i18nKey="overview.step2"
              values={{ expression: readExpression('OPENAI_API_KEY') }}
              components={{ code: <code /> }}
            />
          </li>
          {team ? (
            <li>{t('overview.stepTeam')}</li>
          ) : published ? (
            <li>{t('overview.stepPublished')}</li>
          ) : (
            <li>{t('details.publishLater')}</li>
          )}
        </ol>
      </section>

      <section className="skl-section-block">
        <h4>{t('overview.inApp')}</h4>
        <ul className="skl-facts">
          {facts.map(([label, value]) => (
            <li key={label}>
              <span>{label}</span>
              <span>{value}</span>
            </li>
          ))}
          <li>
            <span>{t('overview.functions')}</span>
            <span>{functionsEnabled ? t('status.on') : t('status.off')}</span>
          </li>
        </ul>
        {!functionsEnabled && (
          <p className="skl-note">
            <Codicon name="info" />
            <span>{t('overview.noFunctions')}</span>
          </p>
        )}
      </section>

      <button type="button" className="skl-link skl-side-foot" onClick={() => openDocs('secrets')}>
        {t('overview.learnMore')} <Codicon name="link-external" />
      </button>
    </aside>
  )
}
