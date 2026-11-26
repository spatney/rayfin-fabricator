import { useLayoutEffect, useMemo, useRef, type JSX } from 'react'
import type { TFunction } from 'i18next'
import type { ToolMakerEvent } from '@shared/ipc'
import { formatList, useTranslation } from '../../i18n'
import { highlightLines } from '../../syntax'
import { CheckIcon, Codicon } from '../icons'

/** A page Copilot read, without its scheme: `platform.openai.com/docs/…`. */
export function pageOf(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
  } catch {
    return url
  }
}

/** Where Copilot is, as a run's events tell it. */
export type LivePhase =
  'starting' | 'planning' | 'reading' | 'writing' | 'fixing' | 'checking' | 'finishing'

type Check =
  { state: 'running' } | { state: 'works'; tools: string[] } | { state: 'failed'; error: string }

/** What Copilot does as it makes a tool, from its run's events. */
export interface Live {
  phase: LivePhase
  /** Copilot started again from what went wrong. */
  again: boolean
  /** The model it runs on, once it's known. */
  model?: string
  /** The pages it read, each once. */
  pages: string[]
  /** The tool's code: as far as Copilot has written it, then as it saved it. */
  code?: string
  /** Copilot is writing the code now. */
  writing: boolean
  /** The end of what Copilot says now. */
  saying?: string
  /** How the last check went. */
  check?: Check
}

export const LIVE_START: Live = { phase: 'starting', again: false, pages: [], writing: false }

/** `live` after `event`. */
export function liveOf(live: Live, event: ToolMakerEvent): Live {
  switch (event.kind) {
    case 'started':
      return {
        ...live,
        phase: live.phase === 'starting' ? 'planning' : live.phase,
        model: event.model ?? live.model
      }
    case 'saying':
      return { ...live, saying: event.text }
    case 'reading': {
      const page = pageOf(event.url)
      const pages = live.pages.includes(page) ? live.pages : [...live.pages, page]
      return { ...live, pages, phase: 'reading', writing: false }
    }
    case 'writing':
      return {
        ...live,
        code: event.code,
        writing: true,
        phase: live.check?.state === 'failed' ? 'fixing' : 'writing'
      }
    case 'checking':
      return { ...live, phase: 'checking', writing: false, check: { state: 'running' } }
    case 'works':
      return { ...live, phase: 'finishing', check: { state: 'works', tools: event.tools } }
    case 'failed':
      return { ...live, phase: 'fixing', check: { state: 'failed', error: event.error } }
    case 'retrying':
      return { ...live, phase: 'starting', again: true, writing: false, saying: undefined }
  }
}

const STAGES = ['plan', 'read', 'write', 'check'] as const
type Stage = (typeof STAGES)[number]
export type StageState = 'done' | 'current' | 'todo' | 'skipped' | 'failed'

/** The stage each phase is in; past the last once the tool works. */
const STAGE_AT: Record<LivePhase, number> = {
  starting: 0,
  planning: 0,
  reading: 1,
  writing: 2,
  fixing: 2,
  checking: 3,
  finishing: 4
}

/** How far each stage got, while Copilot works or once it's done or failed. */
export function stageStates(live: Live, outcome: 'running' | 'done' | 'failed'): StageState[] {
  const passed = (stage: Stage): StageState =>
    stage === 'read' && live.pages.length === 0 ? 'skipped' : 'done'
  if (outcome === 'done') return STAGES.map(passed)
  const at = outcome === 'failed' && live.check?.state === 'failed' ? 3 : STAGE_AT[live.phase]
  return STAGES.map((stage, i) => {
    if (i < at) return passed(stage)
    if (i === at) return outcome === 'failed' ? 'failed' : 'current'
    // While Copilot fixes the code, the check it didn't pass stays marked.
    return stage === 'check' && live.check?.state === 'failed' ? 'failed' : 'todo'
  })
}

/** How many lines `code` has. */
function lineCount(code: string): number {
  return code.replace(/\n$/, '').split('\n').length
}

function StageMark({ state }: { state: StageState }): JSX.Element | null {
  switch (state) {
    case 'done':
      return <CheckIcon />
    case 'current':
      return <span className="mcp-stage-dot" />
    case 'failed':
      return <Codicon name="close" />
    case 'skipped':
      return <Codicon name="dash" />
    case 'todo':
      return null
  }
}

/**
 * Plan, Read docs, Write code and Check: where Copilot is, each with what it
 * got to, such as the pages it read and the lines it wrote.
 */
export function StageTrack({
  live,
  outcome,
  modelName
}: {
  live: Live
  outcome: 'running' | 'done' | 'failed'
  /** The model's name, once it's known. */
  modelName?: string
}): JSX.Element {
  const { t } = useTranslation('mcp')
  const states = stageStates(live, outcome)
  function metric(stage: Stage, state: StageState): string {
    switch (stage) {
      case 'plan':
        return modelName ?? (live.phase === 'starting' ? t('tools.stages.starting') : '')
      case 'read':
        if (live.pages.length) return t('tools.stages.pages', { count: live.pages.length })
        return state === 'skipped' ? t('tools.stages.notNeeded') : ''
      case 'write':
        return live.code ? t('tools.stages.lines', { count: lineCount(live.code) }) : ''
      case 'check':
        if (live.check?.state === 'works') return t('tools.stages.works')
        return live.check?.state === 'failed' ? t('tools.stages.didntStart') : ''
    }
  }
  return (
    <ol className="mcp-stages" aria-label={t('tools.stages.label')}>
      {STAGES.map((stage, i) => {
        const state = states[i]
        const detail = metric(stage, state)
        return (
          <li
            key={stage}
            className={`mcp-stage mcp-stage--${state}`}
            aria-current={state === 'current' ? 'step' : undefined}
          >
            <span className="mcp-stage-mark" aria-hidden="true">
              <StageMark state={state} />
            </span>
            <span className="mcp-stage-label">
              {t(`tools.stages.${stage}` as const)}
              <span className="sr-only">, {t(`tools.stages.state.${state}` as const)}</span>
            </span>
            <span className="mcp-stage-meta" title={detail || undefined}>
              {detail || '\u00a0'}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** What Copilot says, as plain text: its Markdown's marks dropped, and only
 * its last words when it says a lot. */
export function plainSaying(text: string, max = 220): string {
  const plain = text
    .replace(/\*\*|__|`/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (plain.length <= max) return plain
  const cut = plain.slice(plain.length - max)
  return `…${cut.slice(cut.indexOf(' ') + 1)}`
}

/** How a check went, under the code. */
function CheckLine({ check, live }: { check: Check; live: boolean }): JSX.Element {
  const { t } = useTranslation('mcp')
  return (
    <div className={`mcp-live-foot mcp-live-foot--${check.state}`}>
      <span className="mcp-live-foot-icon" aria-hidden="true">
        {check.state === 'running' ? (
          <Codicon name="loading" className="codicon-modifier-spin" />
        ) : check.state === 'works' ? (
          <Codicon name="pass" />
        ) : (
          <Codicon name="error" />
        )}
      </span>
      <span className="mcp-live-foot-text">
        {check.state === 'running'
          ? t('tools.run.checking')
          : check.state === 'works'
            ? t('tools.run.works', { tools: formatList(check.tools) })
            : live
              ? t('tools.run.failed')
              : t('tools.run.didntStart')}
        {check.state === 'failed' && (
          <details className="mcp-step-more">
            <summary>{t('tools.run.details')}</summary>
            <span className="mcp-step-detail">{check.error}</span>
          </details>
        )}
      </span>
    </div>
  )
}

/** The tool's code as Copilot writes it, kept scrolled to its end unless you scroll up. */
function CodeLive({ live }: { live: Live & { code: string } }): JSX.Element {
  const { t } = useTranslation('mcp')
  const body = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const lines = useMemo(() => {
    const all = live.code.split('\n')
    // A last empty line shows only while Copilot is writing it.
    return !live.writing && all.length > 1 && all[all.length - 1] === '' ? all.slice(0, -1) : all
  }, [live.code, live.writing])
  const html = useMemo(() => highlightLines(lines, 'javascript', false), [lines])
  useLayoutEffect(() => {
    const node = body.current
    if (node && pinned.current) node.scrollTop = node.scrollHeight
  }, [lines])
  const count = lineCount(live.code)
  return (
    <section className="mcp-live" aria-label={t('tools.live.code', { count })}>
      <div className="mcp-live-head">
        <Codicon name="file-code" />
        <span className="mcp-live-title mcp-mono">server.mjs</span>
        <span className="mcp-live-meta">{t('tools.stages.lines', { count })}</span>
      </div>
      <div
        ref={body}
        className="mcp-live-body"
        tabIndex={0}
        onScroll={(event) => {
          const node = event.currentTarget
          pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24
        }}
      >
        <pre className="mcp-live-code">
          <code className="hljs">
            {lines.map((line, i) => (
              <span key={i} className="mcp-live-line">
                <span className="mcp-live-no" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="mcp-live-text">
                  {html ? <span dangerouslySetInnerHTML={{ __html: html[i] }} /> : line}
                  {live.writing && i === lines.length - 1 && (
                    <span className="mcp-caret" aria-hidden="true" />
                  )}
                </span>
              </span>
            ))}
          </code>
        </pre>
      </div>
      {live.check && <CheckLine check={live.check} live />}
    </section>
  )
}

/** The pages Copilot read, the latest last. */
function PagesLive({ pages }: { pages: string[] }): JSX.Element {
  const { t } = useTranslation('mcp')
  const body = useRef<HTMLOListElement>(null)
  useLayoutEffect(() => {
    const node = body.current
    if (node) node.scrollTop = node.scrollHeight
  }, [pages])
  return (
    <section className="mcp-live" aria-label={t('tools.live.reading')}>
      <div className="mcp-live-head">
        <Codicon name="globe" />
        <span className="mcp-live-title">{t('tools.live.reading')}</span>
        <span className="mcp-live-meta">{t('tools.stages.pages', { count: pages.length })}</span>
      </div>
      <ol ref={body} className="mcp-live-body mcp-live-pages">
        {pages.map((page) => (
          <li key={page}>
            <Codicon name="globe" />
            <span title={page}>{page}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}

/**
 * What Copilot works on now: the request while it starts and plans, the pages
 * as it reads them, then the code as it writes it, and how its check went.
 */
export function LivePanel({
  live,
  request,
  changing
}: {
  live: Live
  request: string
  changing: boolean
}): JSX.Element {
  const { t } = useTranslation('mcp')
  if (live.code !== undefined && STAGE_AT[live.phase] >= 2) {
    return <CodeLive live={{ ...live, code: live.code }} />
  }
  if (live.phase === 'reading' && live.pages.length > 0) return <PagesLive pages={live.pages} />
  const title = changing ? t('tools.live.change') : t('tools.live.request')
  return (
    <section className="mcp-live" aria-label={title}>
      <div className="mcp-live-head">
        <Codicon name="comment" />
        <span className="mcp-live-title">{title}</span>
      </div>
      <p className="mcp-live-body mcp-live-request">{request.trim()}</p>
    </section>
  )
}

/** The headline for where Copilot is. */
export function liveHeadline(live: Live, changing: boolean, t: TFunction<'mcp'>): string {
  switch (live.phase) {
    case 'starting':
      return live.again ? t('tools.run.retrying') : t('tools.run.starting')
    case 'planning':
      return changing ? t('tools.run.planningChange') : t('tools.run.planning')
    case 'reading':
      return t('tools.run.readingDocs')
    case 'writing':
      return t('tools.run.writingCode')
    case 'fixing':
      return t('tools.run.fixing')
    case 'checking':
      return t('tools.run.checking')
    case 'finishing':
      return t('tools.run.finishing')
  }
}
