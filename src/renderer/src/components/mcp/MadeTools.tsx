import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type KeyboardEvent
} from 'react'
import type {
  ByokProviderStatus,
  JsonSchema,
  MadeToolSpec,
  McpServer,
  ToolCode,
  ToolImportPreview,
  ToolMadeResult,
  ToolMakerEvent,
  ToolTryResult
} from '@shared/ipc'
import { authErrorMessage } from '../../authErrors'
import { useCopilotModels } from '../../copilotModels'
import { openDocs } from '../../docsLinks'
import { formatList, useTranslation } from '../../i18n'
import {
  readStoredSelection,
  selectionArgs,
  writeStoredSelection,
  type ModelSelection
} from '../../modelSelection'
import { shortcut } from '../../platform'
import { highlightCode } from '../../syntax'
import { formatBytes } from '../blueprint/localData'
import { DiffView } from '../chat/DiffView'
import { mcpPluginId } from '../chat/plugins'
import { CheckIcon, Codicon } from '../icons'
import Markdown from '../Markdown'
import { ModelPicker } from '../models/ModelPicker'
import { unifiedDiff } from './codeDiff'
import {
  LIVE_START,
  LivePanel,
  liveHeadline,
  liveOf,
  pageOf,
  plainSaying,
  StageTrack,
  type Live
} from './MakerLive'
import { keyProviders, row, valueInputs, ValueRows, type ValueRow } from './McpServerForm'

/** The model the tool maker last used, kept on this computer. */
const MODEL_KEY = 'fabricator.toolMaker.model'

function newRunId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function HelpLink(): JSX.Element {
  const { t } = useTranslation('mcp')
  return (
    <button
      type="button"
      className="btn btn--sm btn--link mcp-help"
      onClick={() => openDocs('makeTools')}
    >
      {t('tools.help')}
    </button>
  )
}

/** A tool's code, highlighted. */
function CodeBlock({ code, label }: { code: string; label: string }): JSX.Element {
  const html = useMemo(() => highlightCode(code, 'javascript')?.html, [code])
  return (
    <pre className="mcp-code" aria-label={label} tabIndex={0}>
      {html ? (
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <code className="hljs">{code}</code>
      )}
    </pre>
  )
}

interface Step {
  key: number
  kind: 'reading' | 'checking' | 'works' | 'failed' | 'retrying'
  text: string
  detail?: string
}

let nextStep = 0

/** Ideas to start a tool from: each fills in what it should do, and the key it needs. */
const IDEAS: readonly {
  id: 'images' | 'icons' | 'fonts' | 'voice'
  icon: string
  key?: { name: string; provider: string }
}[] = [
  { id: 'images', icon: 'file-media', key: { name: 'OPENAI_API_KEY', provider: 'openai' } },
  { id: 'icons', icon: 'star-empty' },
  { id: 'fonts', icon: 'text-size' },
  { id: 'voice', icon: 'unmute', key: { name: 'OPENAI_API_KEY', provider: 'openai' } }
]

/** Seconds as a clock: `0:42`, `12:05`. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/** When something started, and when it ended. */
interface Span {
  started: number
  ended?: number
}

/** The seconds `span` took, or has taken so far, ticking while it runs. */
function useSeconds(span: Span | null): number {
  const [now, setNow] = useState(() => Date.now())
  const running = Boolean(span && span.ended === undefined)
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])
  if (!span) return 0
  return Math.max(0, ((span.ended ?? now) - span.started) / 1000)
}

/** Ctrl+Enter (⌘Enter on macOS) in a form does `run`, rather than start a new line. */
function onCtrlEnter(run: () => void): (event: KeyboardEvent<HTMLFormElement>) => void {
  return (event) => {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return
    if (event.nativeEvent.isComposing) return
    event.preventDefault()
    run()
  }
}

function StepIcon({ kind, live }: { kind: Step['kind']; live: boolean }): JSX.Element {
  switch (kind) {
    case 'reading':
      return <Codicon name="globe" />
    case 'checking':
      return <Codicon name="loading" className={live ? 'codicon-modifier-spin' : undefined} />
    case 'works':
      return <Codicon name="pass" />
    case 'failed':
      return <Codicon name="error" />
    case 'retrying':
      return <Codicon name="refresh" />
  }
}

/** What Copilot did as it worked, a line each; a check that's running spins while `live`. */
function Steps({ steps, live }: { steps: Step[]; live: boolean }): JSX.Element {
  const { t } = useTranslation('mcp')
  return (
    <ol
      className="mcp-steps"
      aria-label={t('tools.run.label')}
      aria-live={live ? 'polite' : undefined}
    >
      {steps.map((step, i) => (
        <li key={step.key} className={`mcp-step mcp-step--${step.kind}`}>
          <span className="mcp-step-icon" aria-hidden="true">
            <StepIcon kind={step.kind} live={live} />
          </span>
          <span className="mcp-step-text">
            {/* Copilot isn't fixing what it ended on. */}
            {!live && step.kind === 'failed' && i === steps.length - 1
              ? t('tools.run.didntStart')
              : step.text}
            {step.detail && (
              <details className="mcp-step-more">
                <summary>{t('tools.run.details')}</summary>
                <span className="mcp-step-detail">{step.detail}</span>
              </details>
            )}
          </span>
        </li>
      ))}
    </ol>
  )
}

/**
 * Makes a tool with Copilot, or changes one it made: what it should do (or
 * what should change), its keys and the model, then what Copilot does as it
 * works, and the tool it made, to try, turn on in the chat beside the dialog,
 * or, for a change, undo.
 */
export function ToolMaker({
  server,
  providers,
  chatPlugins,
  closing = false,
  onMade,
  onRunning,
  onBack,
  onTry,
  onAddKeys,
  onUseInChat,
  onUndo,
  onCloseAnswer
}: {
  /** The tool to change; without one, a tool is made. */
  server?: McpServer
  /** Your model providers, whose keys the tool can get. */
  providers?: ByokProviderStatus[]
  /** The plugins on in the chat beside the dialog; none without a chat. */
  chatPlugins?: readonly string[]
  /** The dialog asks to close while Copilot works: ask whether to stop it. */
  closing?: boolean
  /** Copilot made or changed the tool. */
  onMade: (result: ToolMadeResult) => void
  /** A run started or ended. */
  onRunning: (running: boolean) => void
  onBack: () => void
  onTry: (server: McpServer) => void
  /** Add the keys a tool's code reads that it doesn't get yet. */
  onAddKeys: (server: McpServer, keys: string[]) => void
  /** Turn the tool on in the chat beside the dialog. */
  onUseInChat?: (server: McpServer) => Promise<void>
  /** Undo the change Copilot just made. */
  onUndo?: (server: McpServer) => Promise<void>
  /** Whether to stop Copilot and close, once `closing` asks. */
  onCloseAnswer?: (close: boolean) => void
}): JSX.Element {
  const { t } = useTranslation('mcp')
  const formId = useId()
  const nameId = useId()
  const requestId = useId()
  const ideasId = useId()
  const requestRef = useRef<HTMLTextAreaElement>(null)
  const [name, setName] = useState('')
  const [request, setRequest] = useState('')
  const [keys, setKeys] = useState<ValueRow[]>([])
  const [model, setModel] = useState<ModelSelection>(() => readStoredSelection(MODEL_KEY))
  const [phase, setPhase] = useState<'input' | 'running' | 'done' | 'failed'>('input')
  const [steps, setSteps] = useState<Step[]>([])
  const [live, setLive] = useState<Live>(LIVE_START)
  const [error, setError] = useState<string>()
  const [result, setResult] = useState<ToolMadeResult>()
  const [stopping, setStopping] = useState(false)
  const [span, setSpan] = useState<Span | null>(null)
  /** Turning the tool on in the chat, or undoing the change. */
  const [busy, setBusy] = useState<'use' | 'undo' | null>(null)
  const [undone, setUndone] = useState(false)
  const [actionError, setActionError] = useState<string>()
  const run = useRef<string | null>(null)
  const mounted = useRef(true)
  const seconds = useSeconds(span)
  const { models } = useCopilotModels(true)
  const modelName = live.model
    ? (models.find((m) => m.id === live.model)?.name ?? live.model)
    : undefined
  const changing = Boolean(server)
  const toolName = server?.name ?? name.trim()
  const ready = request.trim().length > 0
  const history = server?.made?.requests ?? []

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      // Leaving stops a run that's still going.
      if (run.current) void window.api.toolMaker.cancel(run.current)
    }
  }, [])

  /** A line in what Copilot did; none for what only shows as it works. */
  function stepOf(event: ToolMakerEvent): Step | null {
    const key = nextStep++
    switch (event.kind) {
      case 'reading':
        return { key, kind: event.kind, text: t('tools.run.reading', { page: pageOf(event.url) }) }
      case 'checking':
        return { key, kind: event.kind, text: t('tools.run.checking') }
      case 'works':
        return {
          key,
          kind: event.kind,
          text: t('tools.run.works', { tools: formatList(event.tools) })
        }
      case 'failed':
        return { key, kind: event.kind, text: t('tools.run.failed'), detail: event.error }
      case 'retrying':
        return { key, kind: event.kind, text: t('tools.run.retrying') }
      case 'started':
      case 'saying':
      case 'writing':
        return null
    }
  }

  function addStep(event: ToolMakerEvent): void {
    const step = stepOf(event)
    if (!step) return
    setSteps((all) => {
      // A page read again isn't news.
      if (
        event.kind === 'reading' &&
        all.some((s) => s.kind === 'reading' && s.text === step.text)
      ) {
        return all
      }
      // How a check went takes the place of "Checking that it starts…".
      if (event.kind === 'works' || event.kind === 'failed') {
        for (let i = all.length - 1; i >= 0; i--) {
          if (all[i].kind === 'works' || all[i].kind === 'failed') break
          if (all[i].kind === 'checking') {
            return [...all.slice(0, i), { ...step, key: all[i].key }, ...all.slice(i + 1)]
          }
        }
      }
      return [...all, step]
    })
  }

  async function start(): Promise<void> {
    const id = newRunId()
    run.current = id
    writeStoredSelection(MODEL_KEY, model)
    setPhase('running')
    setSteps([])
    setLive(LIVE_START)
    setError(undefined)
    setResult(undefined)
    setStopping(false)
    setUndone(false)
    setActionError(undefined)
    setSpan({ started: Date.now() })
    onRunning(true)
    const onEvent = (event: ToolMakerEvent): void => {
      if (!mounted.current) return
      setLive((now) => liveOf(now, event))
      addStep(event)
    }
    try {
      const made = server
        ? await window.api.toolMaker.change(id, server.id, request, selectionArgs(model), onEvent)
        : await window.api.toolMaker.make(
            id,
            { name: name.trim(), request, env: valueInputs(keys) },
            selectionArgs(model),
            onEvent
          )
      onMade(made)
      if (mounted.current) {
        setResult(made)
        setPhase('done')
      }
    } catch (reason) {
      if (mounted.current) {
        setError(authErrorMessage(reason, t('tools.errors.make')))
        setPhase('failed')
      }
    } finally {
      if (mounted.current) setSpan((s) => (s ? { ...s, ended: Date.now() } : s))
      if (run.current === id) run.current = null
      onRunning(false)
    }
  }

  function stop(): void {
    if (!run.current) return
    setStopping(true)
    void window.api.toolMaker.cancel(run.current)
  }

  function submit(event: FormEvent): void {
    event.preventDefault()
    if (ready) void start()
  }

  /** Fills in an idea: what the tool should do, and the key it needs, from Model providers when it's there. */
  function applyIdea(idea: (typeof IDEAS)[number]): void {
    setRequest(t(`tools.ideas.${idea.id}.request` as const))
    const key = idea.key
    if (key) {
      setKeys((rows) => {
        const has = rows.some(
          (r) =>
            r.provider === key.provider || r.name.trim().toLowerCase() === key.name.toLowerCase()
        )
        if (has) return rows
        const saved = keyProviders(providers).some((p) => p.id === key.provider)
        return [...rows, saved ? row(key.name, null, false, key.provider) : row(key.name, '')]
      })
    }
    requestAnimationFrame(() => {
      const field = requestRef.current
      field?.focus()
      field?.setSelectionRange(field.value.length, field.value.length)
    })
  }

  async function act(
    kind: 'use' | 'undo',
    tool: McpServer,
    action: (tool: McpServer) => Promise<void>
  ): Promise<void> {
    setBusy(kind)
    setActionError(undefined)
    try {
      await action(tool)
      if (mounted.current && kind === 'undo') setUndone(true)
    } catch (reason) {
      if (mounted.current) {
        setActionError(
          authErrorMessage(reason, kind === 'use' ? t('tools.errors.use') : t('tools.errors.undo'))
        )
      }
    } finally {
      if (mounted.current) setBusy(null)
    }
  }

  const made = result?.servers.find((s) => s.id === result.id)
  const madeName = made?.name ?? toolName
  const saying = live.saying ? plainSaying(live.saying) : ''
  const missing = result?.missingKeys ?? []
  const onInChat = Boolean(made && chatPlugins?.includes(mcpPluginId(made.id)))
  const canUse = Boolean(made && chatPlugins && onUseInChat && !onInChat)
  const headline =
    phase === 'running'
      ? liveHeadline(live, changing, t)
      : phase === 'done'
        ? undone
          ? t('tools.run.undone', { name: madeName })
          : changing
            ? t('tools.run.changed', { name: madeName })
            : t('tools.run.made', { name: madeName })
        : changing
          ? t('tools.run.notChanged', { name: toolName })
          : t('tools.run.notMade')

  return (
    <>
      <div className="modal-body mcp-body">
        {phase === 'input' ? (
          <form
            id={formId}
            className="mcp-form"
            aria-label={
              server ? t('tools.changeTitle', { name: server.name }) : t('tools.makeTitle')
            }
            onSubmit={submit}
            onKeyDown={onCtrlEnter(() => {
              if (ready) void start()
            })}
          >
            {server ? (
              <>
                {server.made?.summary && (
                  <p className="modal-sub mcp-lead">{server.made.summary}</p>
                )}
                {history.length > 0 && (
                  <details className="mcp-history">
                    <summary>{t('tools.form.history', { count: history.length })}</summary>
                    <ol>
                      {history.map((asked, i) => (
                        <li key={i}>{asked}</li>
                      ))}
                    </ol>
                  </details>
                )}
              </>
            ) : (
              <p className="modal-sub mcp-lead">{t('tools.lead')}</p>
            )}
            <div className="field">
              <label className="field-label" htmlFor={requestId}>
                {changing ? t('tools.form.change') : t('tools.form.request')}
              </label>
              <textarea
                id={requestId}
                ref={requestRef}
                className="field-input mcp-request"
                rows={4}
                maxLength={4000}
                value={request}
                autoFocus
                placeholder={
                  changing ? t('tools.form.changePlaceholder') : t('tools.form.requestPlaceholder')
                }
                onChange={(event) => setRequest(event.target.value)}
              />
              {!changing && <span className="field-hint">{t('tools.form.requestHint')}</span>}
              {!changing && !request.trim() && (
                <div className="mcp-ideas" role="group" aria-labelledby={ideasId}>
                  <span id={ideasId} className="mcp-ideas-label">
                    {t('tools.ideas.label')}
                  </span>
                  <div className="mcp-ideas-list">
                    {IDEAS.map((idea) => (
                      <button
                        key={idea.id}
                        type="button"
                        className="btn btn--xs mcp-idea"
                        onClick={() => applyIdea(idea)}
                      >
                        <Codicon name={idea.icon} />
                        {t(`tools.ideas.${idea.id}.label` as const)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            {!changing && (
              <>
                <div className="field">
                  <label className="field-label" htmlFor={nameId}>
                    {t('form.name')}
                    <span className="mcp-required"> {t('tools.form.optional')}</span>
                  </label>
                  <input
                    id={nameId}
                    className="field-input"
                    value={name}
                    maxLength={60}
                    placeholder={t('tools.form.namePlaceholder')}
                    onChange={(event) => setName(event.target.value)}
                  />
                </div>
                <div className="field">
                  <ValueRows
                    kind="env"
                    title={t('tools.form.keys')}
                    rows={keys}
                    namePlaceholder="OPENAI_API_KEY"
                    valuePlaceholder={t('tools.form.keyValue')}
                    disabled={false}
                    providers={providers}
                    onChange={setKeys}
                  />
                  <span className="field-hint">{t('tools.form.keysHint')}</span>
                </div>
              </>
            )}
            <div className="field mcp-model">
              <span className="field-label">{t('tools.form.model')}</span>
              <ModelPicker
                value={model}
                disabled={false}
                onChange={setModel}
                placement="down"
                overDialog
                label={t('tools.form.model')}
              />
            </div>
            <p className="mcp-trust">
              <Codicon name="shield" />
              <span>{t('tools.form.trust')}</span>
            </p>
            {error && (
              <div className="alert alert--error mcp-pre" role="alert">
                {error}
              </div>
            )}
          </form>
        ) : (
          <div className={`mcp-run mcp-run--${phase}`}>
            <div className="mcp-run-head">
              <span className="mcp-run-icon" aria-hidden="true">
                {phase === 'running' ? (
                  <Codicon name="loading" className="codicon-modifier-spin" />
                ) : phase === 'done' ? (
                  <CheckIcon />
                ) : (
                  <Codicon name="error" />
                )}
              </span>
              <span className="mcp-run-title" role="status">
                {headline}
              </span>
              <span className="mcp-run-time" title={t('tools.run.time')}>
                {clock(seconds)}
              </span>
            </div>
            {phase === 'running' &&
              (saying ? (
                <p className="mcp-run-note mcp-saying">
                  <Codicon name="copilot" />
                  <span className="mcp-saying-text">
                    <span className="sr-only">{t('tools.run.saying')}: </span>
                    {saying}
                  </span>
                </p>
              ) : (
                <p className="mcp-run-note">{t('tools.run.note')}</p>
              ))}
            <StageTrack
              live={live}
              outcome={phase === 'running' ? 'running' : phase === 'done' ? 'done' : 'failed'}
              modelName={modelName}
            />
            {phase === 'running' && <LivePanel live={live} request={request} changing={changing} />}
            {phase === 'failed' && steps.length > 0 && <Steps steps={steps} live={false} />}
            {phase === 'done' && result && !undone && (
              <section className="mcp-made" aria-label={headline}>
                {result.message && (
                  <div className="mcp-made-message">
                    <Markdown>{result.message}</Markdown>
                  </div>
                )}
                {result.tools.length > 0 && (
                  <ul
                    className="mcp-tool-list"
                    aria-label={t('card.toolsLabel', { name: madeName })}
                  >
                    {result.tools.map((tool) => (
                      <li key={tool.name} className="mcp-tool" title={tool.description}>
                        {tool.name}
                      </li>
                    ))}
                  </ul>
                )}
                {missing.length > 0 && made && (
                  <div className="mcp-missing">
                    <Codicon name="key" />
                    <span>
                      {t('tools.run.missingKeys', {
                        keys: formatList(missing),
                        count: missing.length
                      })}
                    </span>
                    <button
                      type="button"
                      className="btn btn--xs"
                      onClick={() => onAddKeys(made, missing)}
                    >
                      {t('tools.run.addKeys')}
                    </button>
                  </div>
                )}
                {changing && made && onUndo && (
                  <div className="mcp-made-undo">
                    <button
                      type="button"
                      className="btn btn--xs btn--ghost"
                      disabled={busy !== null}
                      onClick={() => void act('undo', made, onUndo)}
                    >
                      <Codicon name="discard" />
                      {busy === 'undo' ? t('tools.actions.undoing') : t('tools.actions.undo')}
                    </button>
                  </div>
                )}
              </section>
            )}
            {phase === 'done' && made && !canUse && (
              <p className="acct-note">
                {onInChat ? t('tools.run.onInChat') : t('tools.run.next')}
              </p>
            )}
            {phase === 'done' && steps.length > 0 && (
              <details className="mcp-run-log">
                <summary>{t('tools.run.log', { count: steps.length })}</summary>
                <Steps steps={steps} live={false} />
              </details>
            )}
            {phase === 'failed' && error && (
              <div className="alert alert--error mcp-pre" role="alert">
                {error}
              </div>
            )}
            {actionError && (
              <div className="alert alert--error mcp-pre" role="alert">
                {actionError}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="modal-footer">
        {phase === 'running' && closing ? (
          <>
            <span className="mcp-closing">{t('tools.run.closeAsk')}</span>
            <button type="button" className="btn btn--ghost" onClick={() => onCloseAnswer?.(false)}>
              {t('tools.actions.keepWorking')}
            </button>
            <button type="button" className="btn btn--danger" onClick={() => onCloseAnswer?.(true)}>
              {t('tools.actions.stopAndClose')}
            </button>
          </>
        ) : (
          <>
            <HelpLink />
            {phase === 'input' && (
              <>
                <button type="button" className="btn btn--ghost" onClick={onBack}>
                  {t('actions.cancel')}
                </button>
                <button
                  type="submit"
                  form={formId}
                  className="btn btn--primary"
                  disabled={!ready}
                  title={shortcut('Enter')}
                >
                  {changing ? t('tools.actions.change') : t('tools.actions.make')}
                </button>
              </>
            )}
            {phase === 'running' && (
              <button type="button" className="btn btn--ghost" disabled={stopping} onClick={stop}>
                {stopping ? t('tools.actions.stopping') : t('tools.actions.stop')}
              </button>
            )}
            {phase === 'failed' && (
              <>
                <button type="button" className="btn btn--ghost" onClick={() => setPhase('input')}>
                  {t('tools.actions.edit')}
                </button>
                <button type="button" className="btn btn--primary" onClick={() => void start()}>
                  {t('tools.actions.tryAgain')}
                </button>
              </>
            )}
            {phase === 'done' && (
              <>
                {made && (
                  <button
                    type="button"
                    className="btn btn--ghost"
                    disabled={busy !== null}
                    onClick={() => onTry(made)}
                  >
                    {t('tools.actions.tryIt')}
                  </button>
                )}
                {canUse && made && onUseInChat ? (
                  <>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      disabled={busy !== null}
                      onClick={onBack}
                    >
                      {t('actions.done')}
                    </button>
                    <button
                      type="button"
                      className="btn btn--primary"
                      disabled={busy !== null}
                      onClick={() => void act('use', made, onUseInChat)}
                    >
                      {busy === 'use' ? t('tools.actions.turningOn') : t('tools.actions.useInChat')}
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn btn--primary" onClick={onBack}>
                    {t('actions.done')}
                  </button>
                )}
              </>
            )}
          </>
        )}
      </div>
    </>
  )
}

/**
 * A tool's code, and what was asked of it. After a change, its last change
 * too, as a diff, which you can undo.
 */
export function ToolCodeView({
  server,
  onBack,
  onUndone
}: {
  server: McpServer
  onBack: () => void
  /** The last change was undone: every MCP server, as they are now. */
  onUndone?: (servers: McpServer[]) => void
}): JSX.Element {
  const { t } = useTranslation('mcp')
  const tabsId = useId()
  const [code, setCode] = useState<ToolCode | null>(null)
  const [error, setError] = useState<string>()
  const [copied, setCopied] = useState(false)
  const [tab, setTab] = useState<'code' | 'change'>('code')
  const [askUndo, setAskUndo] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const mounted = useRef(true)
  const requests = server.made?.requests ?? []
  const changed = code?.previous !== undefined
  const diff = useMemo(
    () => (code?.previous === undefined ? '' : unifiedDiff(code.previous, code.code, 'server.mjs')),
    [code]
  )

  useEffect(() => {
    mounted.current = true
    window.api.toolMaker.code(server.id).then(
      (read) => {
        if (mounted.current) setCode(read)
      },
      (reason) => {
        if (mounted.current) setError(authErrorMessage(reason, t('tools.errors.code')))
      }
    )
    return () => {
      mounted.current = false
    }
  }, [server.id])

  async function copy(): Promise<void> {
    if (!code) return
    try {
      await navigator.clipboard.writeText(code.code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      /* clipboard unavailable */
    }
  }

  function reveal(): void {
    window.api.toolMaker
      .reveal(server.id, 'code')
      .catch((reason) => setError(authErrorMessage(reason, t('tools.errors.code'))))
  }

  async function undo(): Promise<void> {
    setUndoing(true)
    setError(undefined)
    try {
      const servers = await window.api.toolMaker.undo(server.id)
      onUndone?.(servers)
    } catch (reason) {
      if (mounted.current) setError(authErrorMessage(reason, t('tools.errors.undo')))
    } finally {
      if (mounted.current) {
        setUndoing(false)
        setAskUndo(false)
      }
    }
  }

  const tabs: { id: 'code' | 'change'; label: string }[] = [
    { id: 'code', label: t('tools.code.code') },
    { id: 'change', label: t('tools.code.change') }
  ]

  return (
    <>
      <div className="modal-body mcp-body">
        {changed && onUndone && (
          <div className="seg mcp-kind" role="tablist" aria-label={t('tools.code.view')}>
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={`${tabsId}-${item.id}`}
                className={`seg-btn${tab === item.id ? ' seg-btn--active' : ''}`}
                aria-selected={tab === item.id}
                onClick={() => setTab(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
        {tab === 'change' && code && changed ? (
          <section className="mcp-change" role="tabpanel" aria-labelledby={`${tabsId}-change`}>
            {requests.length > 0 && (
              <div className="mcp-asked">
                <span className="field-label">{t('tools.code.changeAsked')}</span>
                <p className="mcp-import-text">{requests[requests.length - 1]}</p>
              </div>
            )}
            {diff ? (
              <DiffView diff={diff} projectPath="" />
            ) : (
              <p className="acct-note">{t('tools.code.noDifference')}</p>
            )}
            <div className="mcp-undo">
              {askUndo ? (
                <>
                  <p className="acct-confirm">{t('tools.code.undoAsk', { name: server.name })}</p>
                  <div className="mcp-undo-actions">
                    <button
                      type="button"
                      className="btn btn--xs btn--danger"
                      disabled={undoing}
                      onClick={() => void undo()}
                    >
                      {undoing ? t('tools.actions.undoing') : t('tools.actions.undo')}
                    </button>
                    <button
                      type="button"
                      className="btn btn--xs btn--ghost"
                      disabled={undoing}
                      onClick={() => setAskUndo(false)}
                    >
                      {t('actions.cancel')}
                    </button>
                  </div>
                </>
              ) : (
                <div className="mcp-undo-actions">
                  <button
                    type="button"
                    className="btn btn--xs btn--ghost"
                    onClick={() => setAskUndo(true)}
                  >
                    <Codicon name="discard" />
                    {t('tools.actions.undo')}
                  </button>
                </div>
              )}
            </div>
          </section>
        ) : (
          <>
            {requests.length > 0 && (
              <section className="mcp-asked" aria-label={t('tools.code.asked')}>
                <span className="field-label">{t('tools.code.asked')}</span>
                <ol>
                  {requests.map((request, i) => (
                    <li key={i}>{request}</li>
                  ))}
                </ol>
              </section>
            )}
            {code ? (
              <CodeBlock code={code.code} label={t('tools.code.label')} />
            ) : (
              !error && <p className="acct-note">{t('tools.code.loading')}</p>
            )}
          </>
        )}
        {error && (
          <p className="acct-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="modal-footer">
        <HelpLink />
        <button
          type="button"
          className="btn btn--ghost"
          disabled={!code}
          onClick={() => void copy()}
        >
          <Codicon name={copied ? 'check' : 'copy'} />
          {copied ? t('tools.actions.copied') : t('tools.actions.copy')}
        </button>
        <button type="button" className="btn btn--ghost" onClick={reveal}>
          {t('tools.actions.openFolder')}
        </button>
        <button type="button" className="btn btn--primary" onClick={onBack}>
          {t('tools.actions.back')}
        </button>
      </div>
    </>
  )
}

/** How a try's form asks for one argument. */
type FieldKind = 'text' | 'long' | 'number' | 'integer' | 'boolean' | 'choice' | 'json'

interface Field {
  name: string
  schema: JsonSchema
  required: boolean
  kind: FieldKind
}

/** Arguments whose text runs long, such as a prompt. */
const LONG_TEXT = /prompt|text|description|content|message|query|body|instruction/i

function kindOf(name: string, schema: JsonSchema): FieldKind {
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type
  if (
    Array.isArray(schema.enum) &&
    schema.enum.length > 0 &&
    schema.enum.every((v) => typeof v === 'string')
  ) {
    return 'choice'
  }
  switch (type) {
    case 'string':
      return LONG_TEXT.test(name) ? 'long' : 'text'
    case 'number':
      return 'number'
    case 'integer':
      return 'integer'
    case 'boolean':
      return 'boolean'
    default:
      return 'json'
  }
}

/** The arguments a tool takes, as a try's form asks for them. */
export function fieldsOf(schema: JsonSchema): Field[] {
  const required = new Set(schema.required ?? [])
  return Object.entries(schema.properties ?? {}).map(([name, property]) => ({
    name,
    schema: property ?? {},
    required: required.has(name),
    kind: kindOf(name, property ?? {})
  }))
}

type Values = Record<string, string | boolean>

/** What the form starts with: each argument's default. */
function startValues(fields: Field[]): Values {
  const values: Values = {}
  for (const field of fields) {
    const given = field.schema.default
    if (field.kind === 'boolean') values[field.name] = given === true
    else if (given === undefined) values[field.name] = ''
    else values[field.name] = field.kind === 'json' ? JSON.stringify(given) : String(given)
  }
  return values
}

/** The arguments the form's values make, or the one that isn't right. */
export function argsFrom(
  fields: Field[],
  values: Values
): Record<string, unknown> | { bad: string } {
  const args: Record<string, unknown> = {}
  for (const field of fields) {
    const value = values[field.name]
    if (field.kind === 'boolean') {
      if (value === true) args[field.name] = true
      else if (field.required) args[field.name] = false
      continue
    }
    const text = typeof value === 'string' ? value : ''
    if (!text.trim()) continue
    if (field.kind === 'number' || field.kind === 'integer') {
      const number = Number(text.trim())
      if (!Number.isFinite(number) || (field.kind === 'integer' && !Number.isInteger(number))) {
        return { bad: field.name }
      }
      args[field.name] = number
    } else if (field.kind === 'json') {
      try {
        args[field.name] = JSON.parse(text)
      } catch {
        return { bad: field.name }
      }
    } else {
      args[field.name] = text
    }
  }
  return args
}

/** What each tool was last tried with while Fabricator runs, by server and tool. */
const lastTries = new Map<string, { values: Values; asJson: boolean; json: string }>()

/**
 * Tries a tool's tools as chat would: with its keys, in a folder of its own
 * that stands in for an app's. Shows what each returned and the files it saved.
 * Each tool's form starts with what it was last tried with.
 */
export function ToolTry({
  server,
  onBack
}: {
  server: McpServer
  onBack: () => void
}): JSX.Element {
  const { t } = useTranslation('mcp')
  const formId = useId()
  const [specs, setSpecs] = useState<MadeToolSpec[] | null>(null)
  const [loadError, setLoadError] = useState<string>()
  const [chosen, setChosen] = useState('')
  const [values, setValues] = useState<Values>({})
  const [asJson, setAsJson] = useState(false)
  const [json, setJson] = useState('{}')
  const [running, setRunning] = useState(false)
  const [span, setSpan] = useState<Span | null>(null)
  const [result, setResult] = useState<ToolTryResult>()
  const [error, setError] = useState<string>()
  const run = useRef<string | null>(null)
  const mounted = useRef(true)
  const resultRef = useRef<HTMLElement>(null)
  const elapsed = useSeconds(running ? span : null)

  // A long form leaves the result below it: bring it into view.
  useEffect(() => {
    if (result) resultRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  }, [result])

  const spec = specs?.find((s) => s.name === chosen)
  const fields = useMemo(() => (spec ? fieldsOf(spec.inputSchema) : []), [spec])

  function choose(next: MadeToolSpec): void {
    const nextFields = fieldsOf(next.inputSchema)
    const last = lastTries.get(`${server.id}\n${next.name}`)
    const start = { ...startValues(nextFields), ...last?.values }
    setChosen(next.name)
    setValues(start)
    setAsJson(last?.asJson ?? nextFields.some((f) => f.kind === 'json'))
    setJson(last?.json ?? JSON.stringify(argsOrEmpty(nextFields, start), null, 2))
    setResult(undefined)
    setError(undefined)
  }

  useEffect(() => {
    mounted.current = true
    window.api.toolMaker.specs(server.id).then(
      (list) => {
        if (!mounted.current) return
        setSpecs(list)
        if (list[0]) choose(list[0])
      },
      (reason) => {
        if (mounted.current) setLoadError(authErrorMessage(reason, t('tools.errors.specs')))
      }
    )
    return () => {
      mounted.current = false
      if (run.current) void window.api.toolMaker.cancel(run.current)
    }
  }, [server.id])

  function argsOrEmpty(list: Field[], from: Values): Record<string, unknown> {
    const args = argsFrom(list, from)
    return 'bad' in args && typeof args.bad === 'string' ? {} : args
  }

  function switchJson(next: boolean): void {
    if (next) {
      setJson(JSON.stringify(argsOrEmpty(fields, values), null, 2))
    } else {
      try {
        const parsed = JSON.parse(json) as Record<string, unknown>
        const filled = startValues(fields)
        for (const field of fields) {
          const value = parsed[field.name]
          if (value === undefined) continue
          filled[field.name] =
            field.kind === 'boolean'
              ? value === true
              : field.kind === 'json' || typeof value !== 'string'
                ? JSON.stringify(value)
                : value
        }
        setValues(filled)
      } catch {
        /* keep the form as it was */
      }
    }
    setAsJson(next)
  }

  async function tryIt(): Promise<void> {
    if (!spec || running) return
    let args: Record<string, unknown>
    if (asJson) {
      try {
        const parsed: unknown = JSON.parse(json)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
        args = parsed as Record<string, unknown>
      } catch {
        setError(t('tools.try.badJson'))
        return
      }
    } else {
      const built = argsFrom(fields, values)
      if ('bad' in built && typeof built.bad === 'string') {
        setError(t('tools.try.badValue', { name: built.bad }))
        return
      }
      args = built
    }
    lastTries.set(`${server.id}\n${spec.name}`, { values, asJson, json })
    const id = newRunId()
    run.current = id
    setRunning(true)
    setSpan({ started: Date.now() })
    setError(undefined)
    setResult(undefined)
    try {
      const tried = await window.api.toolMaker.try(id, server.id, spec.name, args)
      if (mounted.current) setResult(tried)
    } catch (reason) {
      if (mounted.current) setError(authErrorMessage(reason, t('tools.errors.try')))
    } finally {
      if (run.current === id) run.current = null
      if (mounted.current) setRunning(false)
    }
  }

  function stop(): void {
    if (run.current) void window.api.toolMaker.cancel(run.current)
  }

  function revealFolder(): void {
    window.api.toolMaker
      .reveal(server.id, 'try')
      .catch((reason) => setError(authErrorMessage(reason, t('tools.errors.try'))))
  }

  const seconds = result ? Math.round(result.ms / 100) / 10 : 0

  return (
    <>
      <div className="modal-body mcp-body">
        <p className="modal-sub mcp-lead">{t('tools.try.lead')}</p>
        {loadError ? (
          <p className="acct-error mcp-pre" role="alert">
            {loadError}
          </p>
        ) : !specs ? (
          <p className="acct-note">{t('tools.try.loading')}</p>
        ) : (
          <form
            id={formId}
            className="mcp-form"
            aria-label={t('tools.tryTitle', { name: server.name })}
            onSubmit={(event) => {
              event.preventDefault()
              void tryIt()
            }}
            onKeyDown={onCtrlEnter(() => void tryIt())}
          >
            {specs.length > 1 && (
              <div className="field">
                <span className="field-label">{t('tools.try.tool')}</span>
                <div className="mcp-choices" role="group" aria-label={t('tools.try.tool')}>
                  {specs.map((s) => (
                    <button
                      key={s.name}
                      type="button"
                      className={`btn btn--xs mcp-mono${s.name === chosen ? ' btn--primary' : ''}`}
                      aria-pressed={s.name === chosen}
                      disabled={running}
                      onClick={() => choose(s)}
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {spec && (
              <>
                <p className="mcp-try-about">
                  {specs.length === 1 && <span className="mcp-mono mcp-try-name">{spec.name}</span>}
                  {spec.readOnly && <span className="acct-badge">{t('tools.try.readOnly')}</span>}
                  <span>{spec.description}</span>
                </p>
                {fields.length > 0 && (
                  <button
                    type="button"
                    className="btn btn--xs btn--ghost mcp-try-mode"
                    disabled={running}
                    onClick={() => switchJson(!asJson)}
                  >
                    <Codicon name={asJson ? 'list-flat' : 'json'} />
                    {asJson ? t('tools.try.asForm') : t('tools.try.asJson')}
                  </button>
                )}
                {fields.length === 0 ? (
                  <p className="acct-note">{t('tools.try.noArgs')}</p>
                ) : asJson ? (
                  <div className="field">
                    <label className="field-label" htmlFor={`${formId}-json`}>
                      {t('tools.try.json')}
                    </label>
                    <textarea
                      id={`${formId}-json`}
                      className="field-input mcp-mono mcp-request"
                      rows={6}
                      spellCheck={false}
                      value={json}
                      disabled={running}
                      onChange={(event) => setJson(event.target.value)}
                    />
                  </div>
                ) : (
                  fields.map((field) => (
                    <ArgField
                      key={`${spec.name}:${field.name}`}
                      field={field}
                      value={values[field.name] ?? ''}
                      disabled={running}
                      onChange={(value) => setValues((all) => ({ ...all, [field.name]: value }))}
                    />
                  ))
                )}
              </>
            )}
            {error && (
              <div className="alert alert--error mcp-pre" role="alert">
                {error}
              </div>
            )}
          </form>
        )}
        {running && (
          <p className="acct-note mcp-try-running">
            <Codicon name="loading" className="codicon-modifier-spin" />
            {t('tools.actions.running')}
            <span className="mcp-run-time">{clock(elapsed)}</span>
          </p>
        )}
        {result && (
          <section
            ref={resultRef}
            className={`mcp-try-result${result.isError ? ' mcp-try-result--error' : ''}`}
            aria-label={t('tools.try.result')}
          >
            <p className="mcp-try-status">
              <span className="mcp-dot" aria-hidden="true" />
              {result.isError
                ? t('tools.try.reported', { seconds })
                : t('tools.try.worked', { seconds })}
            </p>
            {result.content.length === 0 && result.files.length === 0 && (
              <p className="acct-note">{t('tools.try.noOutput')}</p>
            )}
            {result.content.map((item, i) =>
              item.type === 'text' ? (
                <pre key={i} className="mcp-try-text">
                  {item.text}
                </pre>
              ) : (
                <img
                  key={i}
                  className="mcp-try-image"
                  src={item.url}
                  alt={t('tools.try.picture')}
                />
              )
            )}
            {result.files.length > 0 && (
              <div className="mcp-try-files">
                <span className="field-label">{t('tools.try.saved')}</span>
                <ul>
                  {result.files.map((file) => (
                    <li key={file.path}>
                      <span className="mcp-try-file">
                        <span className="mcp-mono">{file.path}</span>
                        <span className="acct-note">{formatBytes(file.size)}</span>
                      </span>
                      {file.image && (
                        <img className="mcp-try-image" src={file.image} alt={file.path} />
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}
      </div>
      <div className="modal-footer">
        <HelpLink />
        <button type="button" className="btn btn--ghost" onClick={revealFolder}>
          {t('tools.actions.openFolder')}
        </button>
        <button type="button" className="btn btn--ghost" disabled={running} onClick={onBack}>
          {t('tools.actions.back')}
        </button>
        {running ? (
          <button type="button" className="btn btn--primary" onClick={stop}>
            {t('tools.actions.stop')}
          </button>
        ) : (
          <button
            type="submit"
            form={formId}
            className="btn btn--primary"
            disabled={!spec}
            title={shortcut('Enter')}
          >
            {t('tools.actions.run')}
          </button>
        )}
      </div>
    </>
  )
}

/** One argument in a try's form. */
function ArgField({
  field,
  value,
  disabled,
  onChange
}: {
  field: Field
  value: string | boolean
  disabled: boolean
  onChange: (value: string | boolean) => void
}): JSX.Element {
  const { t } = useTranslation('mcp')
  const id = useId()
  const label = (
    <>
      <span className="mcp-mono">{field.name}</span>
      {field.required && <span className="mcp-required"> {t('tools.try.required')}</span>}
    </>
  )
  const hint = field.schema.description ? (
    <span className="field-hint">{field.schema.description}</span>
  ) : null
  if (field.kind === 'boolean') {
    return (
      <label className="mcp-check" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>
          <span className="mcp-check-title">{label}</span>
          {hint}
        </span>
      </label>
    )
  }
  const text = typeof value === 'string' ? value : ''
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {field.kind === 'choice' ? (
        <select
          id={id}
          className="field-input"
          value={text}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">{field.required ? '' : t('tools.try.unset')}</option>
          {(field.schema.enum as string[]).map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      ) : field.kind === 'long' || field.kind === 'json' ? (
        <textarea
          id={id}
          className={`field-input mcp-request${field.kind === 'json' ? ' mcp-mono' : ''}`}
          rows={field.kind === 'json' ? 3 : 2}
          spellCheck={field.kind !== 'json'}
          value={text}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          id={id}
          className="field-input"
          inputMode={field.kind === 'text' ? undefined : 'decimal'}
          value={text}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {hint}
    </div>
  )
}

/** Reviews a tool someone shared, and adds it with your own keys. */
export function ToolImport({
  preview,
  providers,
  onAdded,
  onBack
}: {
  preview: ToolImportPreview
  providers?: ByokProviderStatus[]
  onAdded: (result: ToolMadeResult) => void
  onBack: () => void
}): JSX.Element {
  const { t } = useTranslation('mcp')
  const formId = useId()
  const nameId = useId()
  const readOnlyId = useId()
  const [name, setName] = useState(preview.name)
  const [keys, setKeys] = useState<ValueRow[]>(() => {
    const offered = providers ? keyProviders(providers).map((p) => p.id) : null
    return preview.keys.map((key) =>
      key.provider && (!offered || offered.includes(key.provider))
        ? row(key.name, null, false, key.provider)
        : row(key.name, '')
    )
  })
  const [readOnly, setReadOnly] = useState(preview.readOnly)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string>()
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  async function add(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (adding) return
    setAdding(true)
    setError(undefined)
    try {
      const result = await window.api.toolMaker.import({
        path: preview.path,
        digest: preview.digest,
        name,
        env: valueInputs(keys),
        readOnly
      })
      onAdded(result)
    } catch (reason) {
      if (mounted.current) setError(authErrorMessage(reason, t('tools.errors.import')))
    } finally {
      if (mounted.current) setAdding(false)
    }
  }

  return (
    <>
      <div className="modal-body mcp-body">
        <form
          id={formId}
          className="mcp-form"
          aria-label={t('tools.importTitle')}
          onSubmit={(e) => void add(e)}
        >
          <p className="mcp-trust">
            <Codicon name="shield" />
            <span>{t('tools.import.lead')}</span>
          </p>
          <div className="field">
            <label className="field-label" htmlFor={nameId}>
              {t('form.name')}
            </label>
            <input
              id={nameId}
              className="field-input"
              value={name}
              maxLength={60}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          {preview.summary && (
            <div className="field">
              <span className="field-label">{t('tools.import.summary')}</span>
              <p className="mcp-import-text">{preview.summary}</p>
            </div>
          )}
          {preview.requests.length > 0 && (
            <section className="mcp-asked" aria-label={t('tools.import.asked')}>
              <span className="field-label">{t('tools.import.asked')}</span>
              <ol>
                {preview.requests.map((request, i) => (
                  <li key={i}>{request}</li>
                ))}
              </ol>
            </section>
          )}
          <div className="field">
            <ValueRows
              kind="env"
              title={t('tools.form.keys')}
              rows={keys}
              namePlaceholder="API_KEY"
              valuePlaceholder={t('form.values.value')}
              disabled={adding}
              providers={providers}
              onChange={setKeys}
            />
            <span className="field-hint">{t('tools.import.keysHint')}</span>
          </div>
          <label className="mcp-check" htmlFor={readOnlyId}>
            <input
              id={readOnlyId}
              type="checkbox"
              checked={readOnly}
              disabled={adding}
              onChange={(event) => setReadOnly(event.target.checked)}
            />
            <span>
              <span className="mcp-check-title">{t('form.readOnly')}</span>
              <span className="field-hint">{t('form.readOnlyHint')}</span>
            </span>
          </label>
          <div className="field">
            <span className="field-label">{t('tools.import.code')}</span>
            <CodeBlock code={preview.code} label={t('tools.import.code')} />
          </div>
          {error && (
            <div className="alert alert--error mcp-pre" role="alert">
              {error}
            </div>
          )}
        </form>
      </div>
      <div className="modal-footer">
        <HelpLink />
        <button type="button" className="btn btn--ghost" disabled={adding} onClick={onBack}>
          {t('actions.cancel')}
        </button>
        <button
          type="submit"
          form={formId}
          className="btn btn--primary"
          disabled={adding || !name.trim()}
        >
          {adding ? t('tools.actions.adding') : t('tools.actions.add')}
        </button>
      </div>
    </>
  )
}
