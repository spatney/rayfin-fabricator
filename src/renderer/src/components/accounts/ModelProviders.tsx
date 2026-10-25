import { useEffect, useId, useRef, useState, type FormEvent, type JSX } from 'react'
import type { ByokProviderStatus, ByokStatus } from '@shared/ipc'
import { authErrorMessage } from '../../authErrors'
import { invalidateCopilotModels } from '../../copilotModels'
import { openDocs } from '../../docsLinks'
import { Codicon } from '../icons'
import { ProviderLogo } from '../models/ModelLogo'
import { formatTokens } from '../models/ModelPicker'
import { AccountCard, Foot, Row, errorLine, type CardState } from './AccountParts'
import './modelProviders.css'

const PROVIDER_STATE: Partial<Record<CardState, string>> = {
  ok: 'Key saved',
  off: 'No key',
  error: 'Needs attention'
}

/**
 * Accounts → Model providers (your own API keys): a card per
 * provider to add, check, replace or remove an API key, and to choose which of
 * its models the model pickers show. A key only ever goes to the backend, which
 * checks it with the provider and keeps it in the OS credential store.
 */
export function ModelProviders({ focus = false }: { focus?: boolean }): JSX.Element {
  const [status, setStatus] = useState<ByokStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** The running action, e.g. `anthropic:save`. One at a time. */
  const [action, setAction] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string | undefined>>({})
  /** The provider whose key form is open. */
  const [editing, setEditing] = useState<string | null>(null)
  /** The provider asking to confirm removing its key. */
  const [confirming, setConfirming] = useState<string | null>(null)
  const [showAll, setShowAll] = useState<Record<string, boolean>>({})
  const mountedRef = useRef(true)
  const sectionRef = useRef<HTMLElement>(null)
  /** Model choices save in order, so the last one wins. */
  const savingRef = useRef<Promise<unknown>>(Promise.resolve())
  const titleId = useId()

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const load = (): void => {
    window.api.byok.status().then(
      (next) => {
        if (mountedRef.current) setStatus(next)
      },
      (reason) => {
        if (mountedRef.current)
          setLoadError(authErrorMessage(reason, 'Couldn’t read your model providers.'))
      }
    )
  }
  useEffect(load, [])

  // Opened from a model picker's "Manage API keys…": show this section.
  const loaded = status !== null
  useEffect(() => {
    if (focus && loaded) sectionRef.current?.scrollIntoView?.({ block: 'start' })
  }, [focus, loaded])

  const update = (next: ByokProviderStatus): void =>
    setStatus(
      (s) => s && { ...s, providers: s.providers.map((p) => (p.id === next.id ? next : p)) }
    )

  /** Run one key action for `provider`, showing its failure on its card. */
  async function run(
    provider: string,
    verb: string,
    work: () => Promise<ByokProviderStatus>
  ): Promise<boolean> {
    if (action) return false
    setAction(`${provider}:${verb}`)
    setConfirming(null)
    setErrors((all) => ({ ...all, [provider]: undefined }))
    try {
      const next = await work()
      if (mountedRef.current) update(next)
      invalidateCopilotModels()
      return true
    } catch (reason) {
      if (mountedRef.current) {
        setErrors((all) => ({
          ...all,
          [provider]: authErrorMessage(reason, 'That didn’t work. Please try again.')
        }))
        // A failed check of the saved key marks the card; a rejected new key doesn't.
        if (verb === 'refresh') load()
      }
      return false
    } finally {
      if (mountedRef.current) setAction(null)
    }
  }

  const saveKey = async (provider: string, key: string): Promise<void> => {
    if (await run(provider, 'save', () => window.api.byok.setKey(provider, key))) setEditing(null)
  }

  function toggleModel(p: ByokProviderStatus, id: string, on: boolean): void {
    const enabled = on ? [...p.enabled, id] : p.enabled.filter((m) => m !== id)
    update({ ...p, enabled })
    setErrors((all) => ({ ...all, [p.id]: undefined }))
    savingRef.current = savingRef.current.then(() =>
      window.api.byok.setModels(p.id, enabled).then(
        () => invalidateCopilotModels(),
        (reason) => {
          if (!mountedRef.current) return
          setErrors((all) => ({
            ...all,
            [p.id]: authErrorMessage(reason, 'Couldn’t save your choice of models.')
          }))
          load()
        }
      )
    )
  }

  function stateOf(p: ByokProviderStatus): CardState {
    if (action === `${p.id}:save` || action === `${p.id}:refresh`) return 'checking'
    if (!p.hasKey) return 'off'
    return p.error ? 'error' : 'ok'
  }

  const busy = action !== null

  return (
    <section className="byok" ref={sectionRef} aria-labelledby={titleId}>
      <div className="byok-head">
        <h3 className="byok-title" id={titleId}>
          Model providers
        </h3>
        <p className="byok-sub">
          Use models from these providers with your own API keys in Build chat, the Advisor and
          Design. The provider bills you for them. Copilot still runs the conversation, so stay
          signed in to GitHub Copilot.{' '}
          <button type="button" className="byok-link" onClick={() => openDocs('apiKeys')}>
            Learn more
          </button>
        </p>
      </div>

      {!status ? (
        loadError ? (
          errorLine(loadError)
        ) : (
          <p className="acct-note">Loading…</p>
        )
      ) : !status.supported ? (
        <p className="acct-note">
          Fabricator can’t keep API keys safely on this operating system yet.
        </p>
      ) : (
        status.providers.map((p) => {
          const open = editing === p.id
          return (
            <AccountCard
              key={p.id}
              icon={<ProviderLogo provider={p.id} />}
              title={p.name}
              purpose={`${p.description}, billed to your ${p.name} account.`}
              state={stateOf(p)}
              stateLabels={PROVIDER_STATE}
              action={
                !p.hasKey &&
                !open && (
                  <button
                    className="btn btn--sm btn--primary"
                    disabled={busy}
                    aria-label={`Add your ${p.name} API key`}
                    onClick={() => setEditing(p.id)}
                  >
                    Add key
                  </button>
                )
              }
            >
              {p.hasKey && (
                <Row name="API key" meta={`Saved in ${status.store}`}>
                  {confirming === p.id ? (
                    <>
                      <span className="acct-confirm">Remove your {p.name} key?</span>
                      <button
                        className="btn btn--xs btn--danger"
                        disabled={busy}
                        onClick={() =>
                          void run(p.id, 'remove', () => window.api.byok.removeKey(p.id))
                        }
                      >
                        Remove
                      </button>
                      <button
                        className="btn btn--xs btn--ghost"
                        onClick={() => setConfirming(null)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="btn btn--xs btn--ghost"
                        disabled={busy}
                        title={`Check the key with ${p.name} again and update its models`}
                        onClick={() =>
                          void run(p.id, 'refresh', () => window.api.byok.refresh(p.id))
                        }
                      >
                        {action === `${p.id}:refresh` ? 'Checking…' : 'Check again'}
                      </button>
                      {!open && (
                        <button
                          className="btn btn--xs btn--ghost"
                          disabled={busy}
                          onClick={() => setEditing(p.id)}
                        >
                          Replace
                        </button>
                      )}
                      <button
                        className="btn btn--xs btn--ghost acct-quiet"
                        disabled={busy}
                        aria-label={`Remove your ${p.name} API key`}
                        onClick={() => setConfirming(p.id)}
                      >
                        {action === `${p.id}:remove` ? 'Removing…' : 'Remove'}
                      </button>
                    </>
                  )}
                </Row>
              )}
              {p.hasKey && p.models.length > 0 && (
                <ModelChoices
                  provider={p}
                  expanded={Boolean(showAll[p.id])}
                  onExpand={() => setShowAll((all) => ({ ...all, [p.id]: true }))}
                  onToggle={(id, on) => toggleModel(p, id, on)}
                />
              )}
              <Foot>
                {open && (
                  <KeyForm
                    provider={p}
                    store={status.store}
                    replacing={p.hasKey}
                    busy={busy}
                    checking={action === `${p.id}:save`}
                    onSubmit={(key) => saveKey(p.id, key)}
                    onCancel={() => {
                      setEditing(null)
                      setErrors((all) => ({ ...all, [p.id]: undefined }))
                    }}
                  />
                )}
                {errorLine(errors[p.id] ?? p.error)}
              </Foot>
            </AccountCard>
          )
        })
      )}
    </section>
  )
}

/** Which of a provider's models the model pickers show: the ones turned on and
 *  the recommended ones first, then all of them on request. */
function ModelChoices({
  provider,
  expanded,
  onExpand,
  onToggle
}: {
  provider: ByokProviderStatus
  expanded: boolean
  onExpand: () => void
  onToggle: (id: string, on: boolean) => void
}): JSX.Element {
  const enabled = new Set(provider.enabled)
  const preferred = provider.models.filter((m) => enabled.has(m.id) || m.recommended)
  const shown = expanded || preferred.length === 0 ? provider.models : preferred
  const hidden = provider.models.length - shown.length
  return (
    <div className="byok-models">
      <div className="byok-models-head">
        <span>In the model pickers</span>
        <span className="byok-models-count">
          {enabled.size} of {provider.models.length}
        </span>
      </div>
      <ul className="byok-model-list" aria-label={`${provider.name} models in the model pickers`}>
        {shown.map((m) => (
          <li key={m.id} className="byok-model">
            <label className="byok-model-check">
              <input
                type="checkbox"
                checked={enabled.has(m.id)}
                onChange={(event) => onToggle(m.id, event.target.checked)}
              />
              <span className="byok-model-name" title={m.id}>
                {m.name}
              </span>
            </label>
            <span className="byok-model-meta">
              {formatTokens(m.contextWindow)}
              {m.vision ? ' · images' : ''}
            </span>
            {m.recommended && <span className="acct-badge">Recommended</span>}
            {m.deprecated && (
              <span
                className="acct-badge acct-badge--warn"
                title={`${provider.name} is retiring this model`}
              >
                Retiring
              </span>
            )}
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button type="button" className="btn btn--xs btn--ghost byok-more" onClick={onExpand}>
          Show all {provider.models.length} models
        </button>
      )}
    </div>
  )
}

/** Paste an API key; it's checked with the provider before it's kept. */
function KeyForm({
  provider,
  store,
  replacing,
  busy,
  checking,
  onSubmit,
  onCancel
}: {
  provider: ByokProviderStatus
  store: string
  replacing: boolean
  busy: boolean
  checking: boolean
  onSubmit: (key: string) => Promise<void>
  onCancel: () => void
}): JSX.Element {
  const [key, setKey] = useState('')
  const inputId = useId()

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (key.trim()) await onSubmit(key.trim())
  }

  return (
    <form
      className="acct-add"
      aria-label={`${provider.name} API key`}
      onSubmit={(event) => void submit(event)}
    >
      <label className="field-label" htmlFor={inputId}>
        {replacing ? `New ${provider.name} API key` : `${provider.name} API key`}
      </label>
      <input
        id={inputId}
        className="field-input"
        type="password"
        autoCapitalize="none"
        autoComplete="off"
        spellCheck={false}
        autoFocus
        value={key}
        placeholder={`${provider.keyPrefix}…`}
        disabled={checking}
        onChange={(event) => setKey(event.target.value)}
      />
      <span className="field-hint">
        Fabricator checks it with {provider.name}, then keeps it in {store} on this computer.{' '}
        <button
          type="button"
          className="byok-link"
          onClick={() => void window.api.openExternal(provider.keyUrl)}
        >
          Get a key
          <Codicon name="link-external" />
        </button>
      </span>
      <div className="acct-add-actions">
        <button type="submit" className="btn btn--sm btn--primary" disabled={busy || !key.trim()}>
          {checking ? 'Checking…' : replacing ? 'Replace key' : 'Save key'}
        </button>
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          disabled={checking}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
