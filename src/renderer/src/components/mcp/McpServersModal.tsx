import { useEffect, useId, useRef, useState, type JSX } from 'react'
import type { McpCheckResult, McpServer, McpServerInput } from '@shared/ipc'
import { authErrorMessage } from '../../authErrors'
import { openDocs } from '../../docsLinks'
import { loadMcpServers, setMcpServers, useMcpServers } from '../../mcpServers'
import { useModalFocus } from '../../modalFocus'
import { useSuppressPreview } from '../../overlay'
import { CheckIcon, Codicon } from '../icons'
import { serverSummary, type ParsedServer } from './mcpConfig'
import { McpServerForm } from './McpServerForm'
import './mcpServers.css'

/** How many of a server's tools a check lists before "Show all". */
const TOOLS_SHOWN = 8

/** A server to try: Microsoft's documentation, over the web, without signing in. */
const EXAMPLE: ParsedServer = {
  name: 'Microsoft Learn',
  transport: 'http',
  commandLine: '',
  url: 'https://learn.microsoft.com/api/mcp',
  env: [],
  headers: []
}

interface Check {
  running: boolean
  result?: McpCheckResult
}

/** The form that's open: a server being changed, or one being added. */
interface FormState {
  server?: McpServer
  initial?: ParsedServer
}

/**
 * MCP servers (an experiment): the servers you added, which a chat can turn on
 * among its plugins. Add one with the command that starts it or its URL, check
 * that it connects and see its tools, change it, or remove it. The values of a
 * server's environment variables and headers only ever go to the backend.
 */
export default function McpServersModal({
  adding = false,
  onClose,
  onChanged
}: {
  /** Open on the form to add a server. */
  adding?: boolean
  onClose: () => void
  /** A server was saved or removed: chats that had it on may have changed. */
  onChanged?: () => void
}): JSX.Element {
  useSuppressPreview()
  const titleId = useId()
  const formId = useId()
  const dialogRef = useModalFocus<HTMLDivElement>()
  const servers = useMcpServers(true)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [form, setForm] = useState<FormState | null>(adding ? {} : null)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string>()
  const [checks, setChecks] = useState<Record<string, Check>>({})
  const [shownAll, setShownAll] = useState<Record<string, boolean>>({})
  /** The server asking to confirm it's removed. */
  const [confirming, setConfirming] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string | undefined>>({})
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    loadMcpServers().then(
      () => {
        if (mountedRef.current) setLoaded(true)
      },
      (reason) => {
        if (!mountedRef.current) return
        setLoaded(true)
        setLoadError(authErrorMessage(reason, 'Couldn’t read your MCP servers.'))
      }
    )
  }, [])

  // Escape leaves the form first, then the dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (!form) onClose()
      else if (!saving) {
        setForm(null)
        setFormError(undefined)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [form, saving, onClose])

  function openForm(next: FormState): void {
    setConfirming(null)
    setFormError(undefined)
    setForm(next)
  }

  function closeForm(): void {
    setForm(null)
    setFormError(undefined)
  }

  async function check(id: string): Promise<void> {
    setChecks((all) => ({ ...all, [id]: { running: true } }))
    setErrors((all) => ({ ...all, [id]: undefined }))
    let result: McpCheckResult
    try {
      result = await window.api.mcp.check(id)
    } catch (reason) {
      result = {
        status: 'failed',
        error: authErrorMessage(reason, 'Fabricator couldn’t check it.')
      }
    }
    if (mountedRef.current) setChecks((all) => ({ ...all, [id]: { running: false, result } }))
  }

  async function save(input: McpServerInput): Promise<void> {
    setSaving(true)
    setFormError(undefined)
    const before = new Set(servers.map((s) => s.id))
    try {
      const next = await window.api.mcp.save(input)
      setMcpServers(next)
      onChanged?.()
      if (!mountedRef.current) return
      closeForm()
      // Check it straight away: whether it starts, and what it offers.
      const saved = input.id ?? next.find((s) => !before.has(s.id))?.id
      if (saved) void check(saved)
    } catch (reason) {
      if (mountedRef.current) setFormError(authErrorMessage(reason, 'Couldn’t save the server.'))
    } finally {
      if (mountedRef.current) setSaving(false)
    }
  }

  async function remove(server: McpServer): Promise<void> {
    setConfirming(null)
    setRemoving(server.id)
    try {
      const next = await window.api.mcp.remove(server.id)
      setMcpServers(next)
      onChanged?.()
      if (mountedRef.current) {
        setChecks((all) => {
          const rest = { ...all }
          delete rest[server.id]
          return rest
        })
      }
    } catch (reason) {
      if (mountedRef.current) {
        setErrors((all) => ({
          ...all,
          [server.id]: authErrorMessage(reason, 'Couldn’t remove the server.')
        }))
      }
    } finally {
      if (mountedRef.current) setRemoving(null)
    }
  }

  const busy = saving || removing !== null

  return (
    <div className="modal-backdrop" onClick={() => !form && onClose()}>
      <div
        className="modal mcp-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={titleId}>
            {form
              ? form.server
                ? `Edit ${form.server.name}`
                : 'Add an MCP server'
              : 'MCP servers'}
            <span className="mcp-badge">Experiment</span>
          </h2>
          <button
            className="btn btn--sm btn--ghost"
            onClick={onClose}
            aria-label="Close MCP servers"
          >
            ✕
          </button>
        </div>

        <div className="modal-body mcp-body">
          {form ? (
            <McpServerForm
              id={formId}
              server={form.server}
              initial={form.initial}
              busy={saving}
              error={formError}
              onSubmit={(input) => void save(input)}
            />
          ) : (
            <>
              <p className="modal-sub mcp-lead">
                MCP servers give chat more tools, such as searching documentation, drawing charts or
                reading your issue tracker. Add a server here, then turn it on in a chat’s{' '}
                <strong>Plugins</strong>. Chat uses it only when a request needs it.
              </p>
              {!loaded ? (
                <p className="acct-note">Loading…</p>
              ) : loadError ? (
                <p className="acct-error" role="alert">
                  {loadError}
                </p>
              ) : servers.length === 0 ? (
                <div className="mcp-empty">
                  <Codicon name="plug" className="mcp-empty-ico" />
                  <p>
                    You haven’t added a server yet. Add one with the command that starts it or its
                    URL, or paste the configuration from its instructions.
                  </p>
                  <p className="mcp-empty-try">
                    To try one, add Microsoft Learn, which searches Microsoft’s documentation, such
                    as Fabric’s and Power BI’s.
                  </p>
                  <div className="mcp-empty-actions">
                    <button
                      type="button"
                      className="btn btn--sm btn--primary"
                      onClick={() => openForm({})}
                    >
                      <Codicon name="add" />
                      Add a server
                    </button>
                    <button
                      type="button"
                      className="btn btn--sm btn--ghost"
                      onClick={() => openForm({ initial: EXAMPLE })}
                    >
                      Add Microsoft Learn
                    </button>
                  </div>
                </div>
              ) : (
                servers.map((server) => (
                  <ServerCard
                    key={server.id}
                    server={server}
                    check={checks[server.id]}
                    showAll={Boolean(shownAll[server.id])}
                    busy={busy}
                    removing={removing === server.id}
                    confirming={confirming === server.id}
                    error={errors[server.id]}
                    onCheck={() => void check(server.id)}
                    onEdit={() => openForm({ server })}
                    onShowAll={() => setShownAll((all) => ({ ...all, [server.id]: true }))}
                    onAskRemove={() => setConfirming(server.id)}
                    onCancelRemove={() => setConfirming(null)}
                    onRemove={() => void remove(server)}
                  />
                ))
              )}
            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn--sm btn--link mcp-help" onClick={() => openDocs('mcpServers')}>
            MCP servers help
          </button>
          {form ? (
            <>
              <button className="btn btn--ghost" disabled={saving} onClick={closeForm}>
                Cancel
              </button>
              <button type="submit" form={formId} className="btn btn--primary" disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          ) : (
            <>
              {servers.length > 0 && (
                <button className="btn btn--ghost" disabled={busy} onClick={() => openForm({})}>
                  Add a server
                </button>
              )}
              <button className="btn btn--primary" onClick={onClose}>
                Done
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** One server: what it runs or where it is, how its last check went, and what you can do with it. */
function ServerCard({
  server,
  check,
  showAll,
  busy,
  removing,
  confirming,
  error,
  onCheck,
  onEdit,
  onShowAll,
  onAskRemove,
  onCancelRemove,
  onRemove
}: {
  server: McpServer
  check?: Check
  showAll: boolean
  busy: boolean
  removing: boolean
  confirming: boolean
  error?: string
  onCheck: () => void
  onEdit: () => void
  onShowAll: () => void
  onAskRemove: () => void
  onCancelRemove: () => void
  onRemove: () => void
}): JSX.Element {
  const summary = serverSummary(server)
  const running = Boolean(check?.running)
  const result = running ? undefined : check?.result
  const tools = result?.tools ?? []
  const shown = showAll ? tools : tools.slice(0, TOOLS_SHOWN)
  return (
    <section
      className={`acct-card mcp-card${result?.status === 'failed' ? ' acct-card--error' : ''}`}
      aria-label={server.name}
    >
      <div className="acct-head">
        <span className="acct-ico" aria-hidden="true">
          <Codicon name={server.transport === 'stdio' ? 'terminal' : 'globe'} />
        </span>
        <h3 className="acct-title">
          <span className="mcp-name">{server.name}</span>
          {server.readOnly && <span className="acct-badge">Read-only</span>}
          {running ? (
            <span className="acct-chip acct-chip--checking">Checking…</span>
          ) : result?.status === 'connected' ? (
            <span className="acct-ok" role="img" aria-label="Connected" title="Connected">
              <CheckIcon />
            </span>
          ) : result?.status === 'needs-sign-in' ? (
            <span className="acct-chip">Signs in when used</span>
          ) : result?.status === 'failed' ? (
            <span className="acct-chip acct-chip--error">Didn’t connect</span>
          ) : null}
        </h3>
        <p className="acct-purpose mcp-summary" title={summary}>
          {summary}
        </p>
        <div className="acct-head-action">
          <button
            className="btn btn--xs btn--ghost"
            disabled={busy || running}
            aria-label={`Check ${server.name}`}
            title="Start or connect to it, and list its tools"
            onClick={onCheck}
          >
            {running ? 'Checking…' : 'Check'}
          </button>
          <button
            className="btn btn--xs btn--ghost"
            disabled={busy}
            aria-label={`Edit ${server.name}`}
            onClick={onEdit}
          >
            Edit
          </button>
          <button
            className="btn btn--xs btn--ghost acct-quiet"
            disabled={busy}
            aria-label={`Remove ${server.name}`}
            onClick={onAskRemove}
          >
            {removing ? 'Removing…' : 'Remove'}
          </button>
        </div>
      </div>
      {(confirming || error || result) && (
        <div className="acct-foot">
          {confirming && (
            <div className="mcp-confirm">
              <span className="acct-confirm">
                Remove {server.name}? Chats that have it on stop using it.
              </span>
              <button className="btn btn--xs btn--danger" onClick={onRemove}>
                Remove
              </button>
              <button className="btn btn--xs btn--ghost" onClick={onCancelRemove}>
                Cancel
              </button>
            </div>
          )}
          {result?.status === 'connected' && (
            <div className="mcp-tools">
              <span className="acct-note">
                {tools.length === 0
                  ? 'It connected, and offers no tools.'
                  : `It connected, and offers ${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}:`}
              </span>
              {tools.length > 0 && (
                <ul className="mcp-tool-list" aria-label={`${server.name} tools`}>
                  {shown.map((tool) => (
                    <li key={tool.name} className="mcp-tool" title={tool.description}>
                      {tool.name}
                    </li>
                  ))}
                  {shown.length < tools.length && (
                    <li>
                      <button type="button" className="btn btn--xs btn--ghost" onClick={onShowAll}>
                        Show all {tools.length}
                      </button>
                    </li>
                  )}
                </ul>
              )}
            </div>
          )}
          {result?.status === 'needs-sign-in' && (
            <p className="acct-note">
              It needs you to sign in. The first time a message in a chat uses it, Fabricator opens
              its sign-in page in your browser.
            </p>
          )}
          {result?.error && (
            <p className="acct-error" role="alert">
              {result.error}
            </p>
          )}
          {error && (
            <p className="acct-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </section>
  )
}
