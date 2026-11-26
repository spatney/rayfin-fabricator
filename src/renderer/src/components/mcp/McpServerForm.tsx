import {
  useCallback,
  useId,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type RefObject
} from 'react'
import type { ByokProviderStatus, McpServer, McpServerInput, McpValueInput } from '@shared/ipc'
import { useTranslation } from '../../i18n'
import { isMac } from '../../platform'
import { ContextMenu } from '../ContextMenu'
import { Codicon } from '../icons'
import { joinCommandLine, parseConfig, splitCommandLine, type ParsedServer } from './mcpConfig'

/** An environment variable or header in the form. */
export interface ValueRow {
  key: number
  name: string
  /** It's saved: its value stays unless it's changed. */
  saved: boolean
  /** Its new value; null keeps the saved one. */
  value: string | null
  /** An environment variable that gets the key saved for this model provider. */
  provider?: string
}

interface Draft {
  name: string
  kind: 'command' | 'url'
  commandLine: string
  url: string
  sse: boolean
  /** The user chose whether it uses SSE, rather than going by its URL. */
  sseChosen: boolean
  env: ValueRow[]
  headers: ValueRow[]
  readOnly: boolean
}

let nextKey = 0
export const row = (
  name: string,
  value: string | null,
  saved = false,
  provider?: string
): ValueRow => ({
  key: nextKey++,
  name,
  saved,
  value,
  provider
})

/** The environment variable a model provider's key usually goes in. */
const PROVIDER_VARIABLES: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  xai: 'XAI_API_KEY',
  google: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY'
}

export function providerVariable(provider: string): string {
  return (
    PROVIDER_VARIABLES[provider] ?? `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
  )
}

/** The providers whose saved key a variable can get. */
export function keyProviders(providers?: ByokProviderStatus[]): ByokProviderStatus[] {
  return (providers ?? []).filter((p) => p.hasKey && p.endpoint === 'fixed')
}

const usesSse = (url: string): boolean => /\/sse\/?$/i.test(url.trim())

/** A server's saved environment variables, with the ones `missing` asks for. */
function envRows(server?: McpServer, missing: string[] = []): ValueRow[] {
  const saved = (server?.env ?? []).map((name) =>
    row(name, null, true, server?.providerKeys?.[name])
  )
  const added = missing
    .filter((name) => !saved.some((r) => r.name.toLowerCase() === name.toLowerCase()))
    .map((name) => row(name, ''))
  return [...saved, ...added]
}

function draftFrom(server?: McpServer, missing?: string[]): Draft {
  return {
    name: server?.name ?? '',
    kind: server && server.transport !== 'stdio' ? 'url' : 'command',
    commandLine:
      server?.transport === 'stdio' ? joinCommandLine(server.command ?? '', server.args) : '',
    url: server?.url ?? '',
    sse: server?.transport === 'sse',
    sseChosen: Boolean(server),
    env: envRows(server, missing),
    headers: (server?.headers ?? []).map((name) => row(name, null, true)),
    readOnly: server?.readOnly ?? false
  }
}

function draftFromParsed(parsed: ParsedServer): Draft {
  return {
    name: parsed.name,
    kind: parsed.transport === 'stdio' ? 'command' : 'url',
    commandLine: parsed.commandLine,
    url: parsed.url,
    sse: parsed.transport === 'sse',
    sseChosen: true,
    env: parsed.env.map((v) => row(v.name, v.value)),
    headers: parsed.headers.map((v) => row(v.name, v.value)),
    readOnly: false
  }
}

/**
 * What the backend saves for `rows`: a saved value that wasn't changed goes
 * without one, and a variable that gets a provider's key names the provider.
 */
export function valueInputs(rows: ValueRow[]): McpValueInput[] {
  return rows
    .filter((r) => r.name.trim() || r.value || r.provider)
    .map((r) =>
      r.provider
        ? { name: r.name.trim(), provider: r.provider }
        : r.saved && r.value === null
          ? { name: r.name }
          : { name: r.name.trim(), value: r.value ?? '' }
    )
}

/** What the backend saves for `draft`. A tool made with Copilot has no command of its own. */
function inputFrom(draft: Draft, id?: string, made = false): McpServerInput {
  if (made) {
    return {
      id,
      name: draft.name,
      transport: 'stdio',
      env: valueInputs(draft.env),
      readOnly: draft.readOnly
    }
  }
  if (draft.kind === 'command') {
    const words = splitCommandLine(draft.commandLine)
    return {
      id,
      name: draft.name,
      transport: 'stdio',
      command: words[0] ?? '',
      args: words.slice(1),
      env: valueInputs(draft.env),
      readOnly: draft.readOnly
    }
  }
  return {
    id,
    name: draft.name,
    transport: draft.sse ? 'sse' : 'http',
    url: draft.url.trim(),
    headers: valueInputs(draft.headers),
    readOnly: draft.readOnly
  }
}

/**
 * A server's environment variables or headers: a name and a value each. An
 * environment variable can get a key saved in Model providers instead.
 */
export function ValueRows({
  kind,
  rows,
  namePlaceholder,
  valuePlaceholder,
  disabled,
  providers,
  title,
  onChange
}: {
  kind: 'env' | 'header'
  rows: ValueRow[]
  namePlaceholder: string
  valuePlaceholder: string
  disabled: boolean
  /** Your model providers, to offer their keys; none while they're read. */
  providers?: ByokProviderStatus[]
  /** What the rows are called, when not their kind's name. */
  title?: string
  onChange: (rows: ValueRow[]) => void
}): JSX.Element {
  const { t } = useTranslation('mcp')
  const addRef = useRef<HTMLButtonElement>(null)
  const update = (key: number, patch: Partial<ValueRow>): void =>
    onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const withKeys = kind === 'env' ? keyProviders(providers) : []
  // A provider's key goes in one variable.
  const offered = withKeys.filter((p) => !rows.some((r) => r.provider === p.id))
  const providerName = (id: string): string => providers?.find((p) => p.id === id)?.name ?? id
  function addProvider(id: string): void {
    const name = providerVariable(id)
    const taken = rows.some((r) => r.name.trim().toLowerCase() === name.toLowerCase())
    onChange([...rows, row(taken ? '' : name, null, false, id)])
  }
  return (
    <fieldset className="mcp-values" disabled={disabled}>
      <legend className="field-label">{title ?? t(`form.values.${kind}.title` as const)}</legend>
      {rows.map((r) => (
        <div className="mcp-value" key={r.key}>
          {r.saved ? (
            <span className="mcp-value-name" title={r.name}>
              {r.name}
            </span>
          ) : (
            <input
              className="field-input mcp-mono"
              aria-label={t(`form.values.${kind}.nameLabel` as const)}
              value={r.name}
              placeholder={namePlaceholder}
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => update(r.key, { name: event.target.value })}
            />
          )}
          {r.provider ? (
            <span className="mcp-value-provider">
              <Codicon name="key" />
              {t('form.values.providerKey', { provider: providerName(r.provider) })}
            </span>
          ) : r.saved && r.value === null ? (
            <span className="mcp-value-saved">
              {t('form.values.saved')}
              <button
                type="button"
                className="btn btn--xs btn--ghost"
                aria-label={t('form.values.changeLabel', { name: r.name })}
                onClick={() => update(r.key, { value: '' })}
              >
                {t('form.values.change')}
              </button>
            </span>
          ) : (
            <input
              className="field-input mcp-mono"
              type="password"
              aria-label={
                r.name
                  ? t('form.values.valueOf', { name: r.name })
                  : t(`form.values.${kind}.valueLabel` as const)
              }
              value={r.value ?? ''}
              placeholder={r.saved ? t('form.values.newValue') : valuePlaceholder}
              autoComplete="off"
              spellCheck={false}
              autoFocus={r.saved}
              onChange={(event) => update(r.key, { value: event.target.value })}
            />
          )}
          <button
            type="button"
            className="btn btn--xs btn--ghost acct-quiet mcp-value-remove"
            aria-label={
              r.name
                ? t('form.values.remove', { name: r.name })
                : t(`form.values.${kind}.removeLabel` as const)
            }
            title={t('actions.remove')}
            onClick={() => onChange(rows.filter((x) => x.key !== r.key))}
          >
            <Codicon name="close" />
          </button>
        </div>
      ))}
      <div className="mcp-value-adds">
        <button
          ref={addRef}
          type="button"
          className="btn btn--xs btn--ghost acct-add-btn mcp-value-add"
          onClick={() => onChange([...rows, row('', '')])}
        >
          <Codicon name="add" />
          {t(`form.values.${kind}.add` as const)}
        </button>
        {offered.length > 0 && (
          <ProviderKeyMenu providers={offered} fallback={addRef} onPick={addProvider} />
        )}
      </div>
      {kind === 'env' && providers && withKeys.length === 0 && (
        <span className="field-hint">{t('form.values.noProviders')}</span>
      )}
    </fieldset>
  )
}

/**
 * Adds a variable that gets a key you saved in Model providers: a button that
 * opens a menu of them. Focus returns to the button once the menu closes, or
 * to `fallback` when the button went, its last key used.
 */
function ProviderKeyMenu({
  providers,
  fallback,
  onPick
}: {
  providers: ByokProviderStatus[]
  fallback: RefObject<HTMLElement | null>
  onPick: (provider: string) => void
}): JSX.Element {
  const { t } = useTranslation('mcp')
  const ref = useRef<HTMLButtonElement>(null)
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const close = useCallback((): void => {
    setAt(null)
    // Unless a click outside put it somewhere else.
    requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return
      ;(ref.current?.isConnected ? ref.current : fallback.current)?.focus()
    })
  }, [fallback])
  function toggle(): void {
    if (at) {
      close()
      return
    }
    const box = ref.current?.getBoundingClientRect()
    if (box) setAt({ x: box.left, y: box.bottom + 4 })
  }
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="btn btn--xs mcp-provider-pick"
        aria-haspopup="menu"
        aria-expanded={at !== null}
        onClick={toggle}
      >
        <Codicon name="key" />
        {t('form.values.useProvider')}
        <Codicon name="chevron-down" className="mcp-provider-caret" />
      </button>
      {at && (
        <ContextMenu
          x={at.x}
          y={at.y}
          anchor={ref.current}
          label={t('form.values.useProviderLabel')}
          entries={providers.map((p) => ({
            id: p.id,
            label: t('form.values.providerKey', { provider: p.name }),
            icon: 'key',
            run: () => onPick(p.id)
          }))}
          onClose={close}
        />
      )}
    </>
  )
}

/**
 * Adds a server, or changes one: its name, the command that starts it or its
 * URL, its environment variables or headers, and whether chat may use only its
 * read-only tools. A new server can be filled in from a configuration pasted
 * from its instructions. A tool made with Copilot has no command or URL to
 * change: Fabricator runs its code. Submitted by the dialog's Save, through `id`.
 */
export function McpServerForm({
  id,
  server,
  initial,
  missing,
  providers,
  busy,
  error,
  onSubmit
}: {
  /** The form element's id, for the dialog's Save. */
  id: string
  /** The server being changed; without one, a server is added. */
  server?: McpServer
  /** What a new server starts with, such as an example. */
  initial?: ParsedServer
  /** Environment variables to add, such as the keys a made tool's code reads. */
  missing?: string[]
  /** Your model providers, whose keys a variable can get. */
  providers?: ByokProviderStatus[]
  busy: boolean
  error?: string
  onSubmit: (input: McpServerInput) => void
}): JSX.Element {
  const { t } = useTranslation('mcp')
  const [draft, setDraft] = useState<Draft>(() =>
    initial ? draftFromParsed(initial) : draftFrom(server, missing)
  )
  const [pasting, setPasting] = useState(false)
  const [pasted, setPasted] = useState('')
  const [pasteError, setPasteError] = useState<string>()
  const [choices, setChoices] = useState<ParsedServer[]>([])
  const nameId = useId()
  const kindId = useId()
  const commandId = useId()
  const urlId = useId()
  const pasteId = useId()
  const readOnlyId = useId()
  const made = Boolean(server?.made)

  const set = (patch: Partial<Draft>): void => setDraft((d) => ({ ...d, ...patch }))

  function fillIn(): void {
    const result = parseConfig(pasted)
    if ('error' in result) {
      setPasteError(result.error)
      return
    }
    setPasteError(undefined)
    setDraft(draftFromParsed(result.servers[0]))
    if (result.servers.length > 1) {
      setChoices(result.servers)
    } else {
      setChoices([])
      setPasting(false)
    }
  }

  function submit(event: FormEvent): void {
    event.preventDefault()
    if (!busy) onSubmit(inputFrom(draft, server?.id, made))
  }

  const command = draft.kind === 'command'

  return (
    <form
      id={id}
      className="mcp-form"
      aria-label={server ? t('editServer', { name: server.name }) : t('addServer')}
      onSubmit={submit}
    >
      {!server && (
        <div className="mcp-paste">
          {pasting ? (
            <>
              <label className="field-label" htmlFor={pasteId}>
                {t('form.configuration')}
              </label>
              <textarea
                id={pasteId}
                className="field-input mcp-mono mcp-paste-text"
                rows={6}
                spellCheck={false}
                autoFocus
                value={pasted}
                placeholder={
                  '{\n  "mcpServers": {\n    "example": { "command": "npx", "args": ["-y", "example-mcp"] }\n  }\n}'
                }
                onChange={(event) => setPasted(event.target.value)}
              />
              <span className="field-hint">{t('form.pasteHint')}</span>
              {pasteError && (
                <p className="acct-error" role="alert">
                  {pasteError}
                </p>
              )}
              {choices.length > 1 && (
                <div className="mcp-choices" role="group" aria-label={t('form.choicesLabel')}>
                  <span className="field-hint">{t('form.choose', { total: choices.length })}</span>
                  {choices.map((choice, i) => (
                    <button
                      key={i}
                      type="button"
                      className={`btn btn--xs${draft.name === choice.name ? ' btn--primary' : ''}`}
                      onClick={() => setDraft(draftFromParsed(choice))}
                    >
                      {choice.name}
                    </button>
                  ))}
                </div>
              )}
              <div className="acct-add-actions">
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={!pasted.trim()}
                  onClick={fillIn}
                >
                  {t('form.fillIn')}
                </button>
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={() => {
                    setPasting(false)
                    setPasteError(undefined)
                    setChoices([])
                  }}
                >
                  {choices.length > 1 ? t('actions.done') : t('actions.cancel')}
                </button>
              </div>
            </>
          ) : (
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => setPasting(true)}
            >
              <Codicon name="json" />
              {t('form.paste')}
            </button>
          )}
        </div>
      )}

      <div className="field">
        <label className="field-label" htmlFor={nameId}>
          {t('form.name')}
        </label>
        <input
          id={nameId}
          className="field-input"
          value={draft.name}
          maxLength={60}
          placeholder={t('form.namePlaceholder')}
          autoFocus={!server && !initial}
          onChange={(event) => set({ name: event.target.value })}
        />
      </div>

      {!made && (
        <div className="field">
          <span className="field-label" id={kindId}>
            {t('form.startsWith')}
          </span>
          <div className="seg mcp-kind" role="group" aria-labelledby={kindId}>
            <button
              type="button"
              className={`seg-btn${command ? ' seg-btn--active' : ''}`}
              aria-pressed={command}
              onClick={() => set({ kind: 'command' })}
            >
              {t('form.kind.command')}
            </button>
            <button
              type="button"
              className={`seg-btn${command ? '' : ' seg-btn--active'}`}
              aria-pressed={!command}
              onClick={() => set({ kind: 'url' })}
            >
              {t('form.kind.url')}
            </button>
          </div>
        </div>
      )}

      {made ? null : command ? (
        <div className="field">
          <label className="field-label" htmlFor={commandId}>
            {t('form.command')}
          </label>
          <input
            id={commandId}
            className="field-input mcp-mono"
            value={draft.commandLine}
            placeholder="npx -y package-name"
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => set({ commandLine: event.target.value })}
          />
          <span className="field-hint">{t('form.commandHint')}</span>
        </div>
      ) : (
        <div className="field">
          <label className="field-label" htmlFor={urlId}>
            {t('form.url')}
          </label>
          <input
            id={urlId}
            className="field-input mcp-mono"
            type="url"
            value={draft.url}
            placeholder="https://example.com/mcp"
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              const url = event.target.value
              set(draft.sseChosen ? { url } : { url, sse: usesSse(url) })
            }}
          />
          <label className="mcp-check">
            <input
              type="checkbox"
              checked={draft.sse}
              onChange={(event) => set({ sse: event.target.checked, sseChosen: true })}
            />
            {t('form.sse')}
          </label>
        </div>
      )}

      <div className="field">
        {command ? (
          <ValueRows
            kind="env"
            rows={draft.env}
            namePlaceholder="API_KEY"
            valuePlaceholder={t('form.values.value')}
            disabled={busy}
            providers={providers}
            title={made ? t('tools.form.keys') : undefined}
            onChange={(env) => set({ env })}
          />
        ) : (
          <ValueRows
            kind="header"
            rows={draft.headers}
            namePlaceholder="Authorization"
            valuePlaceholder="Bearer …"
            disabled={busy}
            onChange={(headers) => set({ headers })}
          />
        )}
        <span className="field-hint">
          {isMac() ? t('form.secrets.mac') : t('form.secrets.windows')}
        </span>
      </div>

      <label className="mcp-check mcp-read-only" htmlFor={readOnlyId}>
        <input
          id={readOnlyId}
          type="checkbox"
          checked={draft.readOnly}
          onChange={(event) => set({ readOnly: event.target.checked })}
        />
        <span>
          <span className="mcp-check-title">{t('form.readOnly')}</span>
          <span className="field-hint">{t('form.readOnlyHint')}</span>
        </span>
      </label>

      <p className="mcp-trust">
        <Codicon name="shield" />
        <span>{t('form.trust')}</span>
      </p>

      {error && (
        <div className="alert alert--error" role="alert">
          {error}
        </div>
      )}
    </form>
  )
}
