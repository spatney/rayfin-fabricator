import { useEffect, useId, useRef, useState, type FormEvent, type JSX } from 'react'
import type { ByokProviderStatus, ByokStatus } from '@shared/ipc'
import { authErrorMessage } from '../../authErrors'
import { invalidateCopilotModels } from '../../copilotModels'
import { openDocs } from '../../docsLinks'
import { useTranslation } from '../../i18n'
import { Codicon } from '../icons'
import { ProviderLogo } from '../models/ModelLogo'
import { formatTokens } from '../models/ModelPicker'
import { AccountCard, Foot, Row, errorLine, type CardState } from './AccountParts'
import './modelProviders.css'

/**
 * Accounts → Model providers (your own API keys): a card per
 * provider to add, check, replace or remove an API key, and to choose which of
 * its models the model pickers show. A key only ever goes to the backend, which
 * checks it with the provider and keeps it in the OS credential store.
 */
export function ModelProviders({ focus = false }: { focus?: boolean }): JSX.Element {
  const { t } = useTranslation('models')
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
        if (mountedRef.current) setLoadError(authErrorMessage(reason, t('providers.errors.read')))
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
          [provider]: authErrorMessage(reason, t('providers.errors.generic'))
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
            [p.id]: authErrorMessage(reason, t('providers.errors.saveModels'))
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
  const stateLabels: Partial<Record<CardState, string>> = {
    ok: t('providers.state.ok'),
    off: t('providers.state.off'),
    error: t('providers.state.error')
  }

  return (
    <section className="byok" ref={sectionRef} aria-labelledby={titleId}>
      <div className="byok-head">
        <h3 className="byok-title" id={titleId}>
          {t('providers.title')}
        </h3>
        <p className="byok-sub">
          {t('providers.sub')}{' '}
          <button type="button" className="byok-link" onClick={() => openDocs('apiKeys')}>
            {t('actions.learnMore')}
          </button>
        </p>
      </div>

      {!status ? (
        loadError ? (
          errorLine(loadError)
        ) : (
          <p className="acct-note">{t('status.loading')}</p>
        )
      ) : !status.supported ? (
        <p className="acct-note">{t('providers.unsupported')}</p>
      ) : (
        status.providers.map((p) => {
          const open = editing === p.id
          return (
            <AccountCard
              key={p.id}
              icon={<ProviderLogo provider={p.id} />}
              title={p.name}
              purpose={t('providers.purpose', { description: p.description, name: p.name })}
              state={stateOf(p)}
              stateLabels={stateLabels}
              action={
                !p.hasKey &&
                !open && (
                  <button
                    className="btn btn--sm btn--primary"
                    disabled={busy}
                    aria-label={t('providers.addKeyLabel', { name: p.name })}
                    onClick={() => setEditing(p.id)}
                  >
                    {t('providers.addKey')}
                  </button>
                )
              }
            >
              {p.hasKey && (
                <Row
                  name={t('providers.apiKey')}
                  meta={t('providers.savedIn', { store: status.store })}
                >
                  {confirming === p.id ? (
                    <>
                      <span className="acct-confirm">
                        {t('providers.confirmRemove', { name: p.name })}
                      </span>
                      <button
                        className="btn btn--xs btn--danger"
                        disabled={busy}
                        onClick={() =>
                          void run(p.id, 'remove', () => window.api.byok.removeKey(p.id))
                        }
                      >
                        {t('actions.remove')}
                      </button>
                      <button
                        className="btn btn--xs btn--ghost"
                        onClick={() => setConfirming(null)}
                      >
                        {t('actions.cancel')}
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="btn btn--xs btn--ghost"
                        disabled={busy}
                        title={t('providers.checkTitle', { name: p.name })}
                        onClick={() =>
                          void run(p.id, 'refresh', () => window.api.byok.refresh(p.id))
                        }
                      >
                        {action === `${p.id}:refresh`
                          ? t('status.checking')
                          : t('providers.checkAgain')}
                      </button>
                      {!open && (
                        <button
                          className="btn btn--xs btn--ghost"
                          disabled={busy}
                          onClick={() => setEditing(p.id)}
                        >
                          {t('providers.replace')}
                        </button>
                      )}
                      <button
                        className="btn btn--xs btn--ghost acct-quiet"
                        disabled={busy}
                        aria-label={t('providers.removeLabel', { name: p.name })}
                        onClick={() => setConfirming(p.id)}
                      >
                        {action === `${p.id}:remove`
                          ? t('providers.removing')
                          : t('actions.remove')}
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
  const { t } = useTranslation('models')
  const enabled = new Set(provider.enabled)
  const preferred = provider.models.filter((m) => enabled.has(m.id) || m.recommended)
  const shown = expanded || preferred.length === 0 ? provider.models : preferred
  const hidden = provider.models.length - shown.length
  return (
    <div className="byok-models">
      <div className="byok-models-head">
        <span>{t('providers.inPickers')}</span>
        <span className="byok-models-count">
          {t('providers.enabledCount', { enabled: enabled.size, total: provider.models.length })}
        </span>
      </div>
      <ul
        className="byok-model-list"
        aria-label={t('providers.pickerList', { name: provider.name })}
      >
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
              {m.vision ? ` · ${t('providers.images')}` : ''}
            </span>
            {m.recommended && <span className="acct-badge">{t('providers.recommended')}</span>}
            {m.deprecated && (
              <span
                className="acct-badge acct-badge--warn"
                title={t('providers.retiringTitle', { name: provider.name })}
              >
                {t('providers.retiring')}
              </span>
            )}
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button type="button" className="btn btn--xs btn--ghost byok-more" onClick={onExpand}>
          {t('providers.showAll', { total: provider.models.length })}
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
  const { t } = useTranslation('models')
  const [key, setKey] = useState('')
  const inputId = useId()

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (key.trim()) await onSubmit(key.trim())
  }

  return (
    <form
      className="acct-add"
      aria-label={t('providers.keyLabel', { name: provider.name })}
      onSubmit={(event) => void submit(event)}
    >
      <label className="field-label" htmlFor={inputId}>
        {replacing
          ? t('providers.newKeyLabel', { name: provider.name })
          : t('providers.keyLabel', { name: provider.name })}
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
        {t('providers.keyHint', { name: provider.name, store })}{' '}
        <button
          type="button"
          className="byok-link"
          onClick={() => void window.api.openExternal(provider.keyUrl)}
        >
          {t('providers.getKey')}
          <Codicon name="link-external" />
        </button>
      </span>
      <div className="acct-add-actions">
        <button type="submit" className="btn btn--sm btn--primary" disabled={busy || !key.trim()}>
          {checking
            ? t('status.checking')
            : replacing
              ? t('providers.replaceKey')
              : t('providers.saveKey')}
        </button>
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          disabled={checking}
          onClick={onCancel}
        >
          {t('actions.cancel')}
        </button>
      </div>
    </form>
  )
}
