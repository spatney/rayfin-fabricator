import { useEffect, useRef, useState, type JSX } from 'react'
import type { SecretInfo } from '@shared/ipc'
import { openDocs } from '../../docsLinks'
import { relativeTime } from '../advisor/format'
import { Codicon } from '../icons'

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

/** How a function reads the secret. */
export function readExpression(name: string): string {
  return `ctx.Secrets.${name}`
}

/** A chat prompt that hands the secret (its name, never its value) to Copilot. */
export function copilotPrompt(name: string, declared: boolean): string {
  return [
    `This app has a function secret named ${name}. Its value is stored with the deployed app, and Rayfin functions read it as \`${readExpression(name)}\` (see the rayfin-functions skill).`,
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

interface DetailsProps {
  secret: SecretInfo
  /** Where the secret lives, for team apps ("Published app", "Your preview"). */
  environment?: string
  /** Fabricator can change it (not a team app's). */
  canChange: boolean
  /** Changes can't be made right now (the list is reloading). */
  busy: boolean
  /** The app in the Fabric portal, to change a team app's secrets there. */
  portalUrl?: string
  onClose: () => void
  onSetValue: (secret: SecretInfo) => void
  onDelete: (secret: SecretInfo) => void
  onAskCopilot?: (secret: SecretInfo) => void
}

/** The selected secret: its state, how functions read it, and what you can do with it. */
export function SecretDetails({
  secret,
  environment,
  canChange,
  busy,
  portalUrl,
  onClose,
  onSetValue,
  onDelete,
  onAskCopilot
}: DetailsProps): JSX.Element {
  const now = Date.now()
  return (
    <aside className="skl-side skl-side--detail" aria-label={`${secret.name} details`}>
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
          <span className="skl-kicker">{environment ? `Secret · ${environment}` : 'Secret'}</span>
          <h3 className="sec-name">{secret.name}</h3>
          <SecretStatus secret={secret} />
        </div>
      </header>

      {secret.description && <p className="skl-text">{secret.description}</p>}

      {!secret.stored && (
        <p className="sec-warn">
          {canChange
            ? 'The deployed app has no value for this secret, so functions that read it fail. Set a value to fix that.'
            : 'This app has no value for this secret, so functions that read it fail. Set one in the Fabric portal.'}
        </p>
      )}
      {secret.stored && !secret.declared && (
        <p className="skl-note">
          <Codicon name="info" />
          <span>
            <code>rayfin.yml</code> doesn’t list this secret, so functions can’t read it by name yet.{' '}
            {canChange ? 'Set its value again to add it.' : 'Ask Copilot to add it.'}
          </span>
        </p>
      )}

      <section className="skl-section-block">
        <h4>Value</h4>
        {(secret.updatedAt || secret.createdAt) && (
          <ul className="skl-facts">
            {secret.updatedAt && (
              <li>
                <span>Changed</span>
                <span title={new Date(secret.updatedAt).toLocaleString()}>{relativeTime(secret.updatedAt, now)}</span>
              </li>
            )}
            {secret.createdAt && (
              <li>
                <span>Added</span>
                <span title={new Date(secret.createdAt).toLocaleString()}>{relativeTime(secret.createdAt, now)}</span>
              </li>
            )}
          </ul>
        )}
        <p className="skl-hint">
          {secret.stored
            ? 'Hidden. Nobody can read a value back, not even you. To change it, set a new one.'
            : 'Not set yet.'}
        </p>
      </section>

      <section className="skl-section-block">
        <h4>Use it in a function</h4>
        <CopyCode text={readExpression(secret.name)} />
        <p className="skl-text">
          Read it only inside a Rayfin function. Code in the browser can’t see secrets, and shouldn’t.
        </p>
        {onAskCopilot && (
          <button type="button" className="skl-link" onClick={() => onAskCopilot(secret)}>
            <Codicon name="copilot" /> Ask Copilot to use it
          </button>
        )}
      </section>

      <div className="skl-actions">
        {canChange ? (
          <>
            <button type="button" className="btn btn--sm" disabled={busy} onClick={() => onSetValue(secret)}>
              <Codicon name="edit" /> {secret.stored ? 'Replace value' : 'Set value'}
            </button>
            {secret.stored && (
              <button type="button" className="btn btn--sm skl-danger" disabled={busy} onClick={() => onDelete(secret)}>
                <Codicon name="trash" /> Delete
              </button>
            )}
          </>
        ) : (
          portalUrl && (
            <button type="button" className="btn btn--sm" onClick={() => void window.api.openExternal(portalUrl)}>
              Open in Fabric <Codicon name="link-external" />
            </button>
          )
        )}
      </div>
    </aside>
  )
}

/** The side panel while nothing is selected: how secrets work and what this app has. */
export function SecretsOverview({
  facts,
  functionsEnabled,
  team
}: {
  /** Figures for "In this app", as (label, value). */
  facts: [string, string][]
  functionsEnabled: boolean
  /** A team app: its secrets are changed in the Fabric portal. */
  team: boolean
}): JSX.Element {
  return (
    <aside className="skl-side skl-side--overview" aria-label="About secrets">
      <section className="skl-section-block">
        <h4>How secrets work</h4>
        <ol className="skl-how">
          {team ? (
            <li>
              Each deployment keeps its own secrets: the published app, and each person’s preview. Change them in the
              Fabric portal.
            </li>
          ) : (
            <li>
              Add a secret with a name and a value. Fabricator sends the value to your deployed app; it never goes into
              your code or History.
            </li>
          )}
          <li>
            Your app’s functions read it by name, such as <code>{readExpression('OPENAI_API_KEY')}</code>.
          </li>
          <li>Nobody can read a value back. To change one, set a new value.</li>
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
              This app doesn’t use functions yet, and only functions can read secrets. Ask Copilot to add a function
              when you need one. Functions aren’t available in every Fabric region or tenant.
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
