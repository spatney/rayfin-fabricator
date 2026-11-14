import { useId, useState, type FormEvent, type JSX } from 'react'
import type { McpServer, McpServerInput, McpValueInput } from '@shared/ipc'
import { useTranslation } from '../../i18n'
import { isMac } from '../../platform'
import { Codicon } from '../icons'
import { joinCommandLine, parseConfig, splitCommandLine, type ParsedServer } from './mcpConfig'

/** An environment variable or header in the form. */
interface ValueRow {
  key: number
  name: string
  /** It's saved: its value stays unless it's changed. */
  saved: boolean
  /** Its new value; null keeps the saved one. */
  value: string | null
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
const row = (name: string, value: string | null, saved = false): ValueRow => ({
  key: nextKey++,
  name,
  saved,
  value
})

const usesSse = (url: string): boolean => /\/sse\/?$/i.test(url.trim())

function draftFrom(server?: McpServer): Draft {
  return {
    name: server?.name ?? '',
    kind: server && server.transport !== 'stdio' ? 'url' : 'command',
    commandLine:
      server?.transport === 'stdio' ? joinCommandLine(server.command ?? '', server.args) : '',
    url: server?.url ?? '',
    sse: server?.transport === 'sse',
    sseChosen: Boolean(server),
    env: (server?.env ?? []).map((name) => row(name, null, true)),
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

/** What the backend saves for `draft`: a saved value that wasn't changed goes without one. */
function inputFrom(draft: Draft, id?: string): McpServerInput {
  const values = (rows: ValueRow[]): McpValueInput[] =>
    rows
      .filter((r) => r.name.trim() || r.value)
      .map((r) =>
        r.saved && r.value === null
          ? { name: r.name }
          : { name: r.name.trim(), value: r.value ?? '' }
      )
  if (draft.kind === 'command') {
    const words = splitCommandLine(draft.commandLine)
    return {
      id,
      name: draft.name,
      transport: 'stdio',
      command: words[0] ?? '',
      args: words.slice(1),
      env: values(draft.env),
      readOnly: draft.readOnly
    }
  }
  return {
    id,
    name: draft.name,
    transport: draft.sse ? 'sse' : 'http',
    url: draft.url.trim(),
    headers: values(draft.headers),
    readOnly: draft.readOnly
  }
}

/** A server's environment variables or headers: a name and a value each. */
function ValueRows({
  kind,
  rows,
  namePlaceholder,
  valuePlaceholder,
  disabled,
  onChange
}: {
  kind: 'env' | 'header'
  rows: ValueRow[]
  namePlaceholder: string
  valuePlaceholder: string
  disabled: boolean
  onChange: (rows: ValueRow[]) => void
}): JSX.Element {
  const { t } = useTranslation('mcp')
  const update = (key: number, patch: Partial<ValueRow>): void =>
    onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  return (
    <fieldset className="mcp-values" disabled={disabled}>
      <legend className="field-label">{t(`form.values.${kind}.title` as const)}</legend>
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
          {r.saved && r.value === null ? (
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
      <button
        type="button"
        className="btn btn--xs btn--ghost acct-add-btn mcp-value-add"
        onClick={() => onChange([...rows, row('', '')])}
      >
        <Codicon name="add" />
        {t(`form.values.${kind}.add` as const)}
      </button>
    </fieldset>
  )
}

/**
 * Adds a server, or changes one: its name, the command that starts it or its
 * URL, its environment variables or headers, and whether chat may use only its
 * read-only tools. A new server can be filled in from a configuration pasted
 * from its instructions. Submitted by the dialog's Save, through `id`.
 */
export function McpServerForm({
  id,
  server,
  initial,
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
  busy: boolean
  error?: string
  onSubmit: (input: McpServerInput) => void
}): JSX.Element {
  const { t } = useTranslation('mcp')
  const [draft, setDraft] = useState<Draft>(() =>
    initial ? draftFromParsed(initial) : draftFrom(server)
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
    if (!busy) onSubmit(inputFrom(draft, server?.id))
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

      {command ? (
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
