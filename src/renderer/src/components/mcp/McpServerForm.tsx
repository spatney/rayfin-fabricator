import { useId, useState, type FormEvent, type JSX } from 'react'
import type { McpServer, McpServerInput, McpValueInput } from '@shared/ipc'
import { isMac } from '../../platform'
import { Codicon } from '../icons'
import { joinCommandLine, parseConfig, splitCommandLine, type ParsedServer } from './mcpConfig'

/** Where a server's values are kept, as people know it. */
export const SECRET_STORE = isMac() ? 'your Keychain' : 'Windows Credential Manager'

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
  title,
  noun,
  rows,
  namePlaceholder,
  valuePlaceholder,
  disabled,
  onChange
}: {
  title: string
  noun: string
  rows: ValueRow[]
  namePlaceholder: string
  valuePlaceholder: string
  disabled: boolean
  onChange: (rows: ValueRow[]) => void
}): JSX.Element {
  const update = (key: number, patch: Partial<ValueRow>): void =>
    onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  return (
    <fieldset className="mcp-values" disabled={disabled}>
      <legend className="field-label">{title}</legend>
      {rows.map((r) => (
        <div className="mcp-value" key={r.key}>
          {r.saved ? (
            <span className="mcp-value-name" title={r.name}>
              {r.name}
            </span>
          ) : (
            <input
              className="field-input mcp-mono"
              aria-label={`${noun} name`}
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
              Saved
              <button
                type="button"
                className="btn btn--xs btn--ghost"
                aria-label={`Change the value of ${r.name}`}
                onClick={() => update(r.key, { value: '' })}
              >
                Change
              </button>
            </span>
          ) : (
            <input
              className="field-input mcp-mono"
              type="password"
              aria-label={`Value of ${r.name || noun}`}
              value={r.value ?? ''}
              placeholder={r.saved ? 'New value' : valuePlaceholder}
              autoComplete="off"
              spellCheck={false}
              autoFocus={r.saved}
              onChange={(event) => update(r.key, { value: event.target.value })}
            />
          )}
          <button
            type="button"
            className="btn btn--xs btn--ghost acct-quiet mcp-value-remove"
            aria-label={`Remove ${r.name || noun}`}
            title="Remove"
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
        Add {noun}
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
      aria-label={server ? `Edit ${server.name}` : 'Add an MCP server'}
      onSubmit={submit}
    >
      {!server && (
        <div className="mcp-paste">
          {pasting ? (
            <>
              <label className="field-label" htmlFor={pasteId}>
                Configuration
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
              <span className="field-hint">
                Paste the JSON from the server’s instructions, its command or its URL. Fabricator
                fills in the form for you to check.
              </span>
              {pasteError && (
                <p className="acct-error" role="alert">
                  {pasteError}
                </p>
              )}
              {choices.length > 1 && (
                <div className="mcp-choices" role="group" aria-label="Servers in the configuration">
                  <span className="field-hint">
                    It has {choices.length} servers. Choose the one to add:
                  </span>
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
                  Fill in
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
                  {choices.length > 1 ? 'Done' : 'Cancel'}
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
              Paste a configuration…
            </button>
          )}
        </div>
      )}

      <div className="field">
        <label className="field-label" htmlFor={nameId}>
          Name
        </label>
        <input
          id={nameId}
          className="field-input"
          value={draft.name}
          maxLength={60}
          placeholder="Charts"
          autoFocus={!server && !initial}
          onChange={(event) => set({ name: event.target.value })}
        />
      </div>

      <div className="field">
        <span className="field-label" id={kindId}>
          Starts with
        </span>
        <div className="seg mcp-kind" role="group" aria-labelledby={kindId}>
          <button
            type="button"
            className={`seg-btn${command ? ' seg-btn--active' : ''}`}
            aria-pressed={command}
            onClick={() => set({ kind: 'command' })}
          >
            A command
          </button>
          <button
            type="button"
            className={`seg-btn${command ? '' : ' seg-btn--active'}`}
            aria-pressed={!command}
            onClick={() => set({ kind: 'url' })}
          >
            A URL
          </button>
        </div>
      </div>

      {command ? (
        <div className="field">
          <label className="field-label" htmlFor={commandId}>
            Command
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
          <span className="field-hint">
            The command that starts the server, with its arguments, as you’d type it in a terminal.
            Fabricator runs it on this computer, in the app’s folder.
          </span>
        </div>
      ) : (
        <div className="field">
          <label className="field-label" htmlFor={urlId}>
            URL
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
            It uses Server-Sent Events (SSE), as some older servers do
          </label>
        </div>
      )}

      <div className="field">
        {command ? (
          <ValueRows
            title="Environment variables"
            noun="variable"
            rows={draft.env}
            namePlaceholder="API_KEY"
            valuePlaceholder="Value"
            disabled={busy}
            onChange={(env) => set({ env })}
          />
        ) : (
          <ValueRows
            title="Headers"
            noun="header"
            rows={draft.headers}
            namePlaceholder="Authorization"
            valuePlaceholder="Bearer …"
            disabled={busy}
            onChange={(headers) => set({ headers })}
          />
        )}
        <span className="field-hint">
          For keys and tokens. Fabricator keeps their values in {SECRET_STORE}, not in its settings,
          and never shows them again.
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
          <span className="mcp-check-title">Only tools that read</span>
          <span className="field-hint">
            Chat can call only the tools the server marks as read-only, so it can’t change anything
            with the server. In a team app, that’s always the case.
          </span>
        </span>
      </label>

      <p className="mcp-trust">
        <Codicon name="shield" />
        <span>
          A server runs with your access to this computer and your accounts, and what chat sends it
          leaves Fabricator. Add only servers you trust.
        </span>
      </p>

      {error && (
        <div className="alert alert--error" role="alert">
          {error}
        </div>
      )}
    </form>
  )
}
