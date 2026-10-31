import { useEffect, useId, useRef, useState, type JSX } from 'react'
import type { SecretInfo } from '@shared/ipc'
import { openDocs } from '../../docsLinks'
import { relativeTime } from '../advisor/format'
import { Codicon } from '../icons'
import type { LocalSource, SecretEntry } from './entries'

/** A secret's state as a small dot and a word (the Skills tab's status styles). */
export function SecretStatus({ secret }: { secret: SecretInfo }): JSX.Element {
  const [tone, label] = !secret.stored
    ? ['update', 'No value']
    : secret.declared
      ? ['on', 'Set']
      : ['off', 'Not in rayfin.yml']
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

const LOCAL: Record<LocalSource, ValueState> = {
  none: { tone: 'update', label: 'Not set' },
  local: { tone: 'on', label: 'Set on this computer' },
  env: { tone: 'on', label: 'From your environment' },
  settings: { tone: 'on', label: 'From local.settings.json' }
}

const UNKNOWN: ValueState = { tone: 'off', label: 'Couldn’t check' }

/** A secret's value on this computer, or `null` when there's nothing to say. */
export function localValueState(entry: SecretEntry, check: Check): ValueState | null {
  if (!entry.local) return check === 'failed' ? UNKNOWN : null
  if (entry.declared) return LOCAL[entry.local]
  // Functions don't get a secret rayfin.yml doesn't list: its value isn't used.
  return entry.local === 'none' ? null : { ...LOCAL[entry.local], tone: 'off' }
}

/** A secret's value on the published app, or `null` when there's nothing to say. */
export function publishedValueState(entry: SecretEntry, check: Check): ValueState | null {
  if (check === 'failed') return UNKNOWN
  if (check === 'loading') return null
  if (entry.published?.stored) return { tone: entry.declared ? 'on' : 'off', label: 'Set' }
  return entry.declared ? { tone: 'update', label: 'Not set' } : null
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
        aria-label={copied ? 'Copied' : `Copy ${text}`}
        title={copied ? 'Copied' : 'Copy'}
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
  return (
    <>
      <button
        type="button"
        className="skl-icon-btn skl-side-close"
        onClick={onClose}
        aria-label="Close details"
        title="Close (Esc)"
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
  if (!secret.updatedAt && !secret.createdAt) return null
  const now = Date.now()
  return (
    <ul className="skl-facts">
      {secret.updatedAt && (
        <li>
          <span>Changed</span>
          <span title={new Date(secret.updatedAt).toLocaleString()}>
            {relativeTime(secret.updatedAt, now)}
          </span>
        </li>
      )}
      {secret.createdAt && (
        <li>
          <span>Added</span>
          <span title={new Date(secret.createdAt).toLocaleString()}>
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
  return (
    <section className="skl-section-block">
      <h4>Use it in a function</h4>
      <CopyCode text={readExpression(name)} />
      <p className="skl-text">
        Read it only inside a Rayfin function. Code in the browser can’t see secrets, and shouldn’t.
      </p>
      {onAskCopilot && (
        <button type="button" className="skl-link" onClick={onAskCopilot}>
          <Codicon name="copilot" /> Ask Copilot to use it
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
  return (
    <aside className="skl-side skl-side--detail" aria-label={`${secret.name} details`}>
      <DetailsHead
        name={secret.name}
        kicker={environment ? `Secret · ${environment}` : 'Secret'}
        status={<SecretStatus secret={secret} />}
        onClose={onClose}
      />

      {secret.description && <p className="skl-text">{secret.description}</p>}

      {!secret.stored && (
        <p className="sec-warn">
          This app has no value for this secret, so functions that read it fail. Set one in the
          Fabric portal.
        </p>
      )}
      {secret.stored && !secret.declared && (
        <p className="skl-note">
          <Codicon name="info" />
          <span>
            <code>rayfin.yml</code> doesn’t list this secret, so functions can’t read it by name
            yet. Ask Copilot to add it.
          </span>
        </p>
      )}

      <section className="skl-section-block">
        <h4>Value</h4>
        <ValueDates secret={secret} />
        <p className="skl-hint">
          {secret.stored
            ? 'Hidden. Nobody can read a value back, not even you. To change it, set a new one.'
            : 'Not set yet.'}
        </p>
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
            Open in Fabric <Codicon name="link-external" />
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
function localHint(entry: SecretEntry, check: Check): JSX.Element | null {
  switch (entry.local) {
    case undefined:
      return (
        <p className="skl-hint">
          {check === 'failed' ? 'Fabricator couldn’t check this value.' : 'Checking…'}
        </p>
      )
    case 'none':
      return entry.declared ? (
        <p className="sec-warn">
          Functions that read it fail when your app runs on this computer. Set a value to fix that.
        </p>
      ) : null
    case 'local':
      return (
        <p className="skl-hint">
          Saved in your project’s <code>.rayfin-local</code> folder, outside your code and History.
          {entry.declared && ' To change it, set a new one.'}
        </p>
      )
    case 'env':
      return (
        <p className="skl-hint">
          Your app uses the <code>{entry.name}</code> environment variable Fabricator started with.
          To change it, change the variable and restart Fabricator.
        </p>
      )
    case 'settings':
      return (
        <p className="skl-hint">
          Read from <code>local.settings.json</code> in your functions folder. A value you set here
          is used instead.
        </p>
      )
  }
}

/**
 * A personal app's secret: its value on this computer, its value on the
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
  const localId = useId()
  const publishedId = useId()
  // An unused secret without a value here still says so, like its published value.
  const local = localCheck
    ? (localValueState(entry, localCheck) ??
      (entry.local === 'none' ? { tone: 'off' as const, label: 'Not set' } : null))
    : null
  const published = entry.published
  const stored = Boolean(published?.stored)
  // The environment's value always wins, so one set here wouldn't be used.
  const canSetLocal =
    Boolean(localCheck) && entry.declared && entry.local !== 'env' && localCheck !== 'loading'
  const hasLocal = entry.local === 'local' || entry.local === 'settings'

  return (
    <aside className="skl-side skl-side--detail" aria-label={`${entry.name} details`}>
      <DetailsHead
        name={entry.name}
        kicker="Secret"
        status={
          entry.declared ? null : (
            <ValueStatus state={{ tone: 'off', label: 'Not in rayfin.yml' }} />
          )
        }
        onClose={onClose}
      />

      {entry.description && <p className="skl-text">{entry.description}</p>}

      {!entry.declared && (
        <p className="skl-note">
          <Codicon name="info" />
          <span>
            <code>rayfin.yml</code> doesn’t list this secret, so functions can’t read it by name.{' '}
            {stored
              ? 'Set its published value again to add it.'
              : 'Remove its value if you don’t need it.'}
          </span>
        </p>
      )}

      {localCheck && (
        <section className="skl-section-block" aria-labelledby={localId}>
          <h4 id={localId}>Local value</h4>
          {local && <ValueStatus state={local} />}
          {localHint(entry, localCheck)}
          {(canSetLocal || entry.local === 'local') && (
            <div className="sec-actions">
              {canSetLocal && (
                <button type="button" className="btn btn--sm" onClick={() => onSetLocal(entry)}>
                  <Codicon name="edit" /> {hasLocal ? 'Change' : 'Set'}
                </button>
              )}
              {entry.local === 'local' && (
                <button
                  type="button"
                  className="btn btn--sm skl-danger"
                  onClick={() => onRemoveLocal(entry)}
                >
                  <Codicon name="trash" /> Remove
                </button>
              )}
            </div>
          )}
        </section>
      )}

      <section className="skl-section-block" aria-labelledby={publishedId}>
        <h4 id={publishedId}>Published value</h4>
        {publishedCheck === null ? (
          <p className="skl-hint">Values for the published app can be set after you publish it.</p>
        ) : publishedCheck === 'failed' ? (
          <p className="skl-hint">Fabricator couldn’t read your published app’s values.</p>
        ) : publishedCheck === 'loading' ? (
          <p className="skl-hint">Checking…</p>
        ) : (
          <>
            <ValueStatus
              state={publishedValueState(entry, 'ok') ?? { tone: 'off', label: 'Not set' }}
            />
            {published && <ValueDates secret={published} />}
            {stored ? (
              <p className="skl-hint">
                Hidden. Nobody can read a value back, not even you. To change it, set a new one.
              </p>
            ) : (
              entry.declared && (
                <p className="sec-warn">
                  Your published app has no value for this secret, so its functions that read it
                  fail. Set one to fix that.
                </p>
              )
            )}
            {(entry.declared || stored) && (
              <div className="sec-actions">
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={busy}
                  onClick={() => onSetPublished(entry)}
                >
                  <Codicon name="edit" /> {stored ? 'Replace value' : 'Set value'}
                </button>
                {stored && (
                  <button
                    type="button"
                    className="btn btn--sm skl-danger"
                    disabled={busy}
                    onClick={() => onDeletePublished(entry)}
                  >
                    <Codicon name="trash" /> Delete
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
  /** A team app: its secrets are changed in the Fabric portal. */
  team: boolean
  /** A personal app that has been published, so it has published values too. */
  published?: boolean
}): JSX.Element {
  return (
    <aside className="skl-side skl-side--overview" aria-label="About secrets">
      <section className="skl-section-block">
        <h4>How secrets work</h4>
        <ol className="skl-how">
          {team ? (
            <li>
              The published app and each person’s preview keep their own secrets. Change them in the
              Fabric portal.
            </li>
          ) : (
            <li>
              Add a secret with a name and a value. The value stays on this computer, outside your
              code and History.
            </li>
          )}
          <li>
            Your app’s functions read it by name, such as{' '}
            <code>{readExpression('OPENAI_API_KEY')}</code>.
          </li>
          {team ? (
            <li>Nobody can read a value back. To change one, set a new value.</li>
          ) : published ? (
            <li>
              Your published app keeps its own values. Nobody can read one back: to change it, set a
              new one.
            </li>
          ) : (
            <li>Values for the published app can be set after you publish it.</li>
          )}
        </ol>
      </section>

      <section className="skl-section-block">
        <h4>In this app</h4>
        <ul className="skl-facts">
          {facts.map(([label, value]) => (
            <li key={label}>
              <span>{label}</span>
              <span>{value}</span>
            </li>
          ))}
          <li>
            <span>Functions</span>
            <span>{functionsEnabled ? 'On' : 'Off'}</span>
          </li>
        </ul>
        {!functionsEnabled && (
          <p className="skl-note">
            <Codicon name="info" />
            <span>
              This app doesn’t use functions yet, and only functions can read secrets. Ask Copilot
              to add a function when you need one. Functions aren’t available in every Fabric region
              or tenant.
            </span>
          </p>
        )}
      </section>

      <button type="button" className="skl-link skl-side-foot" onClick={() => openDocs('secrets')}>
        Learn more about secrets <Codicon name="link-external" />
      </button>
    </aside>
  )
}
