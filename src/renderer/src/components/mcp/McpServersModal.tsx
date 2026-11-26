import { useEffect, useId, useRef, useState, type JSX } from 'react'
import type {
  ByokProviderStatus,
  McpCheckResult,
  McpServer,
  McpServerInput,
  ToolImportPreview,
  ToolMadeResult
} from '@shared/ipc'
import { authErrorMessage } from '../../authErrors'
import { openDocs } from '../../docsLinks'
import { Trans, useTranslation } from '../../i18n'
import { loadMcpServers, setMcpServers, useMcpServers } from '../../mcpServers'
import { useModalFocus } from '../../modalFocus'
import { useSuppressPreview } from '../../overlay'
import { mcpPluginId } from '../chat/plugins'
import { CheckIcon, Codicon } from '../icons'
import { serverIcon, serverSummary, type ParsedServer } from './mcpConfig'
import { McpServerForm } from './McpServerForm'
import { ToolCodeView, ToolImport, ToolMaker, ToolTry } from './MadeTools'
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

/**
 * What the dialog shows: the servers, the form that adds or changes one, or,
 * for tools made with Copilot, the tool maker, a tool's code, a try, or a
 * shared tool to add.
 */
type View =
  | { kind: 'list' }
  | { kind: 'form'; server?: McpServer; initial?: ParsedServer; missing?: string[] }
  | { kind: 'make'; server?: McpServer }
  | { kind: 'code'; server: McpServer }
  | { kind: 'try'; server: McpServer }
  | { kind: 'import'; preview: ToolImportPreview }

const LIST: View = { kind: 'list' }

/**
 * MCP servers: the servers you added, which a chat can turn on among its
 * plugins. Add one with the command that starts it or its URL, check that it
 * connects and see its tools, change it, or remove it. The values of a
 * server's environment variables and headers only ever go to the backend.
 * With the Make tools with Copilot experiment on, Copilot can also make a tool
 * from a description, change it, and you can try a tool, read its code, undo
 * its last change, share it as a file, and turn it on in the chat beside the
 * dialog.
 */
export default function McpServersModal({
  adding = false,
  making = false,
  makeTools = false,
  chat,
  onClose,
  onChanged
}: {
  /** Open on the form to add a server. */
  adding?: boolean
  /** Open on making a tool with Copilot (with `makeTools`). */
  making?: boolean
  /** The Make tools with Copilot experiment is on. */
  makeTools?: boolean
  /** The chat beside the dialog, where a tool you make can be turned on. */
  chat?: { projectId: string; plugins: readonly string[] }
  onClose: () => void
  /** A server was saved or removed: chats that had it on may have changed. */
  onChanged?: () => void
}): JSX.Element {
  const { t } = useTranslation('mcp')
  useSuppressPreview()
  const titleId = useId()
  const formId = useId()
  const dialogRef = useModalFocus<HTMLDivElement>()
  const servers = useMcpServers()
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [view, setView] = useState<View>(
    making && makeTools ? { kind: 'make' } : adding ? { kind: 'form' } : LIST
  )
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string>()
  const [checks, setChecks] = useState<Record<string, Check>>({})
  const [shownAll, setShownAll] = useState<Record<string, boolean>>({})
  /** The server asking to confirm it's removed. */
  const [confirming, setConfirming] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string | undefined>>({})
  const [notes, setNotes] = useState<Record<string, string | undefined>>({})
  /** Copilot is making or changing a tool. */
  const [toolRunning, setToolRunning] = useState(false)
  /** Closing was asked while Copilot works: the tool maker asks whether to stop it. */
  const [closing, setClosing] = useState(false)
  /** The tool just made, changed or added, highlighted in the list. */
  const [fresh, setFresh] = useState<string | null>(null)
  const [providers, setProviders] = useState<ByokProviderStatus[]>()
  const [listError, setListError] = useState<string>()
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!toolRunning) setClosing(false)
  }, [toolRunning])

  useEffect(() => {
    if (view.kind !== 'list' || !fresh) return
    const timer = window.setTimeout(() => setFresh(null), 2500)
    return () => window.clearTimeout(timer)
  }, [view.kind, fresh])

  useEffect(() => {
    loadMcpServers().then(
      () => {
        if (mountedRef.current) setLoaded(true)
      },
      (reason) => {
        if (!mountedRef.current) return
        setLoaded(true)
        setLoadError(authErrorMessage(reason, t('errors.read')))
      }
    )
    // The keys you saved in Model providers, which an environment variable can get.
    Promise.resolve()
      .then(() => window.api.byok.status())
      .then(
        (status) => {
          if (mountedRef.current) setProviders(status.providers)
        },
        () => {}
      )
  }, [])

  // Escape leaves the form or a tool's view first, then the dialog. While
  // Copilot works, it asks whether to stop it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (view.kind === 'list') onClose()
      else if (toolRunning) setClosing(true)
      else if (!saving) {
        setView(LIST)
        setFormError(undefined)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view, saving, toolRunning, onClose])

  /** Close, unless Copilot is working: then ask first. */
  function requestClose(): void {
    if (toolRunning) setClosing(true)
    else onClose()
  }

  function openView(next: View): void {
    setConfirming(null)
    setFormError(undefined)
    setListError(undefined)
    setView(next)
  }

  function closeForm(): void {
    setView(LIST)
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
        error: authErrorMessage(reason, t('errors.check'))
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
      if (mountedRef.current) setFormError(authErrorMessage(reason, t('errors.save')))
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
          [server.id]: authErrorMessage(reason, t('errors.remove'))
        }))
      }
    } finally {
      if (mountedRef.current) setRemoving(null)
    }
  }

  /** Copilot made or changed a tool, or a shared one was added: it started, with these tools. */
  function madeTool(result: ToolMadeResult): void {
    setMcpServers(result.servers)
    onChanged?.()
    if (!mountedRef.current) return
    setFresh(result.id)
    setChecks((all) => ({
      ...all,
      [result.id]: { running: false, result: { status: 'connected', tools: result.tools } }
    }))
  }

  /** The last change to a tool was undone: check it again, as it is now. */
  function undoneTool(id: string, next: McpServer[]): void {
    setMcpServers(next)
    onChanged?.()
    if (!mountedRef.current) return
    setFresh(id)
    void check(id)
  }

  async function undoChange(server: McpServer): Promise<void> {
    undoneTool(server.id, await window.api.toolMaker.undo(server.id))
  }

  /** Turns a tool on in the chat beside the dialog, and closes the dialog. */
  async function useInChat(server: McpServer): Promise<void> {
    if (!chat) return
    await window.api.chat.setPlugin(chat.projectId, mcpPluginId(server.id), true)
    onChanged?.()
    onClose()
  }

  async function exportTool(server: McpServer): Promise<void> {
    setErrors((all) => ({ ...all, [server.id]: undefined }))
    setNotes((all) => ({ ...all, [server.id]: undefined }))
    try {
      const path = await window.api.toolMaker.export(server.id)
      if (path && mountedRef.current) {
        setNotes((all) => ({ ...all, [server.id]: t('card.exported', { path }) }))
      }
    } catch (reason) {
      if (mountedRef.current) {
        setErrors((all) => ({
          ...all,
          [server.id]: authErrorMessage(reason, t('tools.errors.export'))
        }))
      }
    }
  }

  async function pickImport(): Promise<void> {
    setListError(undefined)
    try {
      const preview = await window.api.toolMaker.pickImport()
      if (preview && mountedRef.current) openView({ kind: 'import', preview })
    } catch (reason) {
      if (mountedRef.current) setListError(authErrorMessage(reason, t('tools.errors.import')))
    }
  }

  const busy = saving || removing !== null
  const title =
    view.kind === 'form'
      ? view.server
        ? t('editServer', { name: view.server.name })
        : t('addServer')
      : view.kind === 'make'
        ? view.server
          ? t('tools.changeTitle', { name: view.server.name })
          : t('tools.makeTitle')
        : view.kind === 'code'
          ? t('tools.codeTitle', { name: view.server.name })
          : view.kind === 'try'
            ? t('tools.tryTitle', { name: view.server.name })
            : view.kind === 'import'
              ? t('tools.importTitle')
              : t('title')

  return (
    <div className="modal-backdrop" onClick={() => view.kind === 'list' && onClose()}>
      <div
        className="modal mcp-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <button className="btn btn--sm btn--ghost" onClick={requestClose} aria-label={t('close')}>
            ✕
          </button>
        </div>

        {view.kind === 'make' ? (
          <ToolMaker
            server={view.server}
            providers={providers}
            chatPlugins={chat?.plugins}
            closing={closing}
            onMade={madeTool}
            onRunning={setToolRunning}
            onBack={() => openView(LIST)}
            onTry={(server) => openView({ kind: 'try', server })}
            onAddKeys={(server, missing) => openView({ kind: 'form', server, missing })}
            onUseInChat={chat ? useInChat : undefined}
            onUndo={undoChange}
            onCloseAnswer={(close) => (close ? onClose() : setClosing(false))}
          />
        ) : view.kind === 'code' ? (
          <ToolCodeView
            server={view.server}
            onBack={() => openView(LIST)}
            onUndone={
              makeTools
                ? (next) => {
                    const id = view.server.id
                    undoneTool(id, next)
                    setNotes((all) => ({ ...all, [id]: t('card.undone') }))
                    openView(LIST)
                  }
                : undefined
            }
          />
        ) : view.kind === 'try' ? (
          <ToolTry server={view.server} onBack={() => openView(LIST)} />
        ) : view.kind === 'import' ? (
          <ToolImport
            preview={view.preview}
            providers={providers}
            onAdded={(result) => {
              madeTool(result)
              openView(LIST)
            }}
            onBack={() => openView(LIST)}
          />
        ) : (
          <>
            <div className="modal-body mcp-body">
              {view.kind === 'form' ? (
                <McpServerForm
                  id={formId}
                  server={view.server}
                  initial={view.initial}
                  missing={view.missing}
                  providers={providers}
                  busy={saving}
                  error={formError}
                  onSubmit={(input) => void save(input)}
                />
              ) : (
                <>
                  <p className="modal-sub mcp-lead">
                    <Trans t={t} i18nKey="lead" components={{ b: <strong /> }} />
                  </p>
                  {makeTools && loaded && !loadError && (
                    <div className="mcp-maker">
                      <p>{t('tools.intro')}</p>
                      <div className="mcp-maker-actions">
                        <button
                          type="button"
                          className="btn btn--sm"
                          disabled={busy}
                          onClick={() => openView({ kind: 'make' })}
                        >
                          <Codicon name="sparkle" />
                          {t('tools.make')}
                        </button>
                        <button
                          type="button"
                          className="btn btn--sm btn--ghost"
                          disabled={busy}
                          onClick={() => void pickImport()}
                        >
                          {t('tools.addShared')}
                        </button>
                      </div>
                      {listError && (
                        <p className="acct-error" role="alert">
                          {listError}
                        </p>
                      )}
                    </div>
                  )}
                  {!loaded ? (
                    <p className="acct-note">{t('status.loading')}</p>
                  ) : loadError ? (
                    <p className="acct-error" role="alert">
                      {loadError}
                    </p>
                  ) : servers.length === 0 ? (
                    <div className="mcp-empty">
                      <Codicon name="plug" className="mcp-empty-ico" />
                      <p>{t('empty')}</p>
                      <p className="mcp-empty-try">{t('tryExample')}</p>
                      <div className="mcp-empty-actions">
                        <button
                          type="button"
                          className="btn btn--sm btn--primary"
                          onClick={() => openView({ kind: 'form' })}
                        >
                          <Codicon name="add" />
                          {t('add')}
                        </button>
                        <button
                          type="button"
                          className="btn btn--sm btn--ghost"
                          onClick={() => openView({ kind: 'form', initial: EXAMPLE })}
                        >
                          {t('addExample')}
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
                        note={notes[server.id]}
                        fresh={fresh === server.id}
                        toolActions={makeTools && Boolean(server.made)}
                        onCheck={() => void check(server.id)}
                        onEdit={() => openView({ kind: 'form', server })}
                        onShowAll={() => setShownAll((all) => ({ ...all, [server.id]: true }))}
                        onAskRemove={() => setConfirming(server.id)}
                        onCancelRemove={() => setConfirming(null)}
                        onRemove={() => void remove(server)}
                        onTry={() => openView({ kind: 'try', server })}
                        onChangeTool={() => openView({ kind: 'make', server })}
                        onCode={() => openView({ kind: 'code', server })}
                        onExport={() => void exportTool(server)}
                      />
                    ))
                  )}
                </>
              )}
            </div>

            <div className="modal-footer">
              <button
                className="btn btn--sm btn--link mcp-help"
                onClick={() => openDocs('mcpServers')}
              >
                {t('help')}
              </button>
              {view.kind === 'form' ? (
                <>
                  <button className="btn btn--ghost" disabled={saving} onClick={closeForm}>
                    {t('actions.cancel')}
                  </button>
                  <button
                    type="submit"
                    form={formId}
                    className="btn btn--primary"
                    disabled={saving}
                  >
                    {saving ? t('status.saving') : t('actions.save')}
                  </button>
                </>
              ) : (
                <>
                  {servers.length > 0 && (
                    <button
                      className="btn btn--ghost"
                      disabled={busy}
                      onClick={() => openView({ kind: 'form' })}
                    >
                      {t('add')}
                    </button>
                  )}
                  <button className="btn btn--primary" onClick={onClose}>
                    {t('actions.done')}
                  </button>
                </>
              )}
            </div>
          </>
        )}
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
  note,
  fresh,
  toolActions,
  onCheck,
  onEdit,
  onShowAll,
  onAskRemove,
  onCancelRemove,
  onRemove,
  onTry,
  onChangeTool,
  onCode,
  onExport
}: {
  server: McpServer
  check?: Check
  showAll: boolean
  busy: boolean
  removing: boolean
  confirming: boolean
  error?: string
  /** What happened, such as where it was exported. */
  note?: string
  /** It was just made, changed or added: it's brought into view and marked. */
  fresh: boolean
  /** Offer what a tool made with Copilot can do: try, change, code and export. */
  toolActions: boolean
  onCheck: () => void
  onEdit: () => void
  onShowAll: () => void
  onAskRemove: () => void
  onCancelRemove: () => void
  onRemove: () => void
  onTry: () => void
  onChangeTool: () => void
  onCode: () => void
  onExport: () => void
}): JSX.Element {
  const { t } = useTranslation('mcp')
  const cardRef = useRef<HTMLElement>(null)
  const summary = serverSummary(server)
  const running = Boolean(check?.running)
  const result = running ? undefined : check?.result
  const tools = result?.tools ?? []
  const shown = showAll ? tools : tools.slice(0, TOOLS_SHOWN)
  useEffect(() => {
    if (fresh) cardRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [fresh])
  return (
    <section
      ref={cardRef}
      className={`acct-card mcp-card${result?.status === 'failed' ? ' acct-card--error' : ''}${
        fresh ? ' mcp-card--fresh' : ''
      }`}
      aria-label={server.name}
    >
      <div className="acct-head">
        <span className="acct-ico" aria-hidden="true">
          <Codicon name={serverIcon(server)} />
        </span>
        <h3 className="acct-title">
          <span className="mcp-name">{server.name}</span>
          {server.made && <span className="acct-badge">{t('card.made')}</span>}
          {server.readOnly && <span className="acct-badge">{t('card.readOnly')}</span>}
          {running ? (
            <span className="acct-chip acct-chip--checking">{t('status.checking')}</span>
          ) : result?.status === 'connected' ? (
            <span
              className="acct-ok"
              role="img"
              aria-label={t('card.connected')}
              title={t('card.connected')}
            >
              <CheckIcon />
            </span>
          ) : result?.status === 'needs-sign-in' ? (
            <span className="acct-chip">{t('card.signsIn')}</span>
          ) : result?.status === 'failed' ? (
            <span className="acct-chip acct-chip--error">{t('card.failed')}</span>
          ) : null}
        </h3>
        <p
          className={`acct-purpose mcp-summary${server.made ? ' mcp-summary--made' : ''}`}
          title={summary}
        >
          {summary}
        </p>
        <div className="acct-head-action">
          <button
            className="btn btn--xs btn--ghost"
            disabled={busy || running}
            aria-label={t('card.checkLabel', { name: server.name })}
            title={t('card.checkTitle')}
            onClick={onCheck}
          >
            {running ? t('status.checking') : t('card.check')}
          </button>
          <button
            className="btn btn--xs btn--ghost"
            disabled={busy}
            aria-label={t('editServer', { name: server.name })}
            onClick={onEdit}
          >
            {t('actions.edit')}
          </button>
          <button
            className="btn btn--xs btn--ghost acct-quiet"
            disabled={busy}
            aria-label={t('card.removeLabel', { name: server.name })}
            onClick={onAskRemove}
          >
            {removing ? t('card.removing') : t('actions.remove')}
          </button>
        </div>
      </div>
      {(confirming || error || result || note || toolActions) && (
        <div className="acct-foot">
          {toolActions && (
            <div className="mcp-made-actions">
              <button
                type="button"
                className="btn btn--xs btn--ghost"
                disabled={busy}
                aria-label={t('card.tryLabel', { name: server.name })}
                onClick={onTry}
              >
                <Codicon name="play" />
                {t('card.try')}
              </button>
              <button
                type="button"
                className="btn btn--xs btn--ghost"
                disabled={busy}
                aria-label={t('card.changeLabel', { name: server.name })}
                onClick={onChangeTool}
              >
                <Codicon name="sparkle" />
                {t('card.change')}
              </button>
              <button
                type="button"
                className="btn btn--xs btn--ghost"
                disabled={busy}
                aria-label={t('card.codeLabel', { name: server.name })}
                onClick={onCode}
              >
                <Codicon name="code" />
                {t('card.code')}
              </button>
              <button
                type="button"
                className="btn btn--xs btn--ghost"
                disabled={busy}
                aria-label={t('card.exportLabel', { name: server.name })}
                onClick={onExport}
              >
                <Codicon name="export" />
                {t('card.export')}
              </button>
            </div>
          )}
          {confirming && (
            <div className="mcp-confirm">
              <span className="acct-confirm">{t('card.confirmRemove', { name: server.name })}</span>
              <button className="btn btn--xs btn--danger" onClick={onRemove}>
                {t('actions.remove')}
              </button>
              <button className="btn btn--xs btn--ghost" onClick={onCancelRemove}>
                {t('actions.cancel')}
              </button>
            </div>
          )}
          {result?.status === 'connected' && (
            <div className="mcp-tools">
              <span className="acct-note">
                {tools.length === 0 ? t('card.noTools') : t('card.tools', { count: tools.length })}
              </span>
              {tools.length > 0 && (
                <ul
                  className="mcp-tool-list"
                  aria-label={t('card.toolsLabel', { name: server.name })}
                >
                  {shown.map((tool) => (
                    <li key={tool.name} className="mcp-tool" title={tool.description}>
                      {tool.name}
                    </li>
                  ))}
                  {shown.length < tools.length && (
                    <li>
                      <button type="button" className="btn btn--xs btn--ghost" onClick={onShowAll}>
                        {t('card.showAll', { total: tools.length })}
                      </button>
                    </li>
                  )}
                </ul>
              )}
            </div>
          )}
          {result?.status === 'needs-sign-in' && (
            <p className="acct-note">{t('card.needsSignIn')}</p>
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
          {note && <p className="acct-note">{note}</p>}
        </div>
      )}
    </section>
  )
}
