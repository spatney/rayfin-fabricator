import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import type { ContextTier, ContextTierOption, CopilotModel, ReasoningEffort } from '@shared/ipc'
import { isFastModel, useAutoTiers, useCopilotModels } from '@renderer/copilotModels'
import { moveMenuFocus } from '@renderer/menuFocus'
import { menuLayout, type MenuLayout } from '@renderer/menuLayout'
import { AUTO_SELECTION, type ModelSelection } from '@renderer/modelSelection'
import { useSuppressPreview } from '@renderer/overlay'
import { Codicon } from '../icons'
import { EFFORT_ORDER } from '../chat/modes'
import { ModelLogo } from './ModelLogo'
import './modelPicker.css'

export { AUTO_SELECTION, selectionOf, type ModelSelection } from '@renderer/modelSelection'

/** Names and hints for reasoning efforts. */
export const EFFORT_LABEL: Record<ReasoningEffort, { label: string; hint: string }> = {
  none: { label: 'None', hint: 'Answers without extra thinking.' },
  low: { label: 'Low', hint: 'Quick — fine for small, clear changes.' },
  medium: { label: 'Medium', hint: 'Balanced speed and care.' },
  high: { label: 'High', hint: 'Thinks longer — good for tricky changes.' },
  xhigh: { label: 'Extra high', hint: 'Thinks much longer on hard problems.' },
  max: { label: 'Max', hint: 'The most thinking — slowest, for the hardest work.' }
}

/** A token count the way windows are named: 200K, 1M, 1.05M. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(2)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
  return String(tokens)
}

const CONTEXT_NAME: Record<ContextTier, string> = { default: 'Standard', long_context: 'Long' }

/** Copilot's models listed before "More models", in Copilot's order. */
const FEATURED = 8
const MAIN_WIDTH = 268
const FLY_WIDTH = 300
const GAP = 6

type Flyout = 'model' | 'effort' | 'context'

/** A saved model the list no longer has, by its id (without a provider prefix). */
function missingName(id: string): string {
  return id.includes('/') ? id.slice(id.indexOf('/') + 1) : id
}

/**
 * The model picker, after GitHub Copilot's: a small menu with an Auto switch
 * (and, on Auto, what it optimizes for) or the chosen model's Model, Effort and
 * Context window, each opening a list beside the menu. The model list has a
 * search, Copilot's first models, the user's own-key models and the rest of
 * Copilot's under More models. Loads the models when it needs them.
 */
export function ModelPicker({
  value,
  disabled,
  onChange,
  tiers = false,
  placement = 'up',
  onManageKeys,
  autoHint,
  label = 'Model'
}: {
  value: ModelSelection
  disabled: boolean
  onChange: (next: ModelSelection) => void
  /** Offer what Auto optimizes for, and context windows. */
  tiers?: boolean
  /** Open above the trigger (the composer) or below it (a toolbar). */
  placement?: 'up' | 'down'
  /** Open Accounts at Model providers; shown while Your own API keys is on. */
  onManageKeys?: () => void
  /** What Auto does here, when it isn't Copilot choosing per request. */
  autoHint?: string
  /** What the picker chooses, e.g. "Design model". */
  label?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [flyout, setFlyout] = useState<Flyout | null>(null)
  // Where the menu opens: beside the trigger, on the side with room. It's drawn
  // at the document root, over the chat and preview panes alike.
  const [layout, setLayout] = useState<MenuLayout>({
    side: placement === 'up' ? 'right' : 'left',
    style: {}
  })
  const [query, setQuery] = useState('')
  const [showMore, setShowMore] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const mainRef = useRef<HTMLDivElement>(null)
  const flyRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const isAuto = !value.model
  const { models, loading } = useCopilotModels(open || !isAuto)
  const autoTiers = useAutoTiers(tiers && open)
  // A flyout reaches past the chat column, over the native preview; a menu
  // opening down from a toolbar covers it too.
  useSuppressPreview(open && (flyout !== null || placement === 'down'))

  const selected = useMemo(() => models.find((m) => m.id === value.model), [models, value.model])
  const missing = !isAuto && !loading && models.length > 0 && !selected
  const copilot = useMemo(() => models.filter((m) => !m.byok), [models])
  const keyModels = useMemo(() => models.filter((m) => m.byok), [models])
  const featured = copilot.slice(0, FEATURED)
  const more = copilot.slice(FEATURED)

  const efforts = selected
    ? EFFORT_ORDER.filter((e) => selected.supportedReasoningEfforts.includes(e))
    : []
  const defaultEffort = selected?.defaultReasoningEffort
  const effort: ReasoningEffort | '' = efforts.length ? value.effort || defaultEffort || '' : ''
  const windows: ContextTierOption[] = tiers ? (selected?.contextTiers ?? []) : []
  const activeWindow =
    windows.find((w) => w.tier === (value.contextTier || 'default')) ?? windows[0]
  const activeTier = value.autoTier || autoTiers?.defaultTier || ''
  const tierName = (id: string): string =>
    autoTiers?.tiers.find((t) => t.id === id)?.name ?? (id ? id[0].toUpperCase() + id.slice(1) : '')

  // Auto names its tier only when one was chosen; Copilot's default goes unsaid.
  const summary = isAuto
    ? ['Auto', tiers && value.autoTier ? tierName(value.autoTier) : '']
    : [
        selected?.name ?? missingName(value.model),
        effort ? EFFORT_LABEL[effort].label : '',
        value.contextTier === 'long_context' && activeWindow
          ? formatTokens(activeWindow.tokens)
          : ''
      ]
  const pillText = summary.filter(Boolean).join(' · ')

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent): void => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !popRef.current?.contains(target)) closeMenu(false)
    }
    const resize = (): void => closeMenu(false)
    window.addEventListener('mousedown', close)
    window.addEventListener('resize', resize)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('resize', resize)
    }
  }, [open])

  // Focus the menu's first item on open, and a flyout's search or current
  // choice when it opens.
  useEffect(() => {
    if (!open) return
    const id = requestAnimationFrame(() =>
      mainRef.current?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')?.focus()
    )
    return () => cancelAnimationFrame(id)
  }, [open])
  useEffect(() => {
    if (!flyout) return
    const id = requestAnimationFrame(() => {
      const fly = flyRef.current
      const current = fly?.querySelector<HTMLElement>('[aria-checked="true"]')
      current?.scrollIntoView?.({ block: 'nearest' })
      if (flyout === 'model') searchRef.current?.focus()
      else
        (current ?? fly?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)'))?.focus()
    })
    return () => cancelAnimationFrame(id)
  }, [flyout])

  function openMenu(): void {
    const r = triggerRef.current?.getBoundingClientRect()
    if (r) setLayout(menuLayout(r, placement, MAIN_WIDTH + GAP + FLY_WIDTH + 12))
    setOpen(true)
  }

  function closeMenu(focusTrigger = true): void {
    setOpen(false)
    setFlyout(null)
    setQuery('')
    setShowMore(false)
    if (focusTrigger) requestAnimationFrame(() => triggerRef.current?.focus())
  }

  function openFlyout(kind: Flyout): void {
    setQuery('')
    if (kind === 'model') setShowMore(more.some((m) => m.id === value.model))
    setFlyout(kind)
  }

  function closeFlyout(): void {
    const kind = flyout
    setFlyout(null)
    setQuery('')
    requestAnimationFrame(() =>
      mainRef.current?.querySelector<HTMLElement>(`[data-sub="${kind}"]`)?.focus()
    )
  }

  const commit = (next: ModelSelection): void => {
    onChange(next)
    closeMenu()
  }

  // A new model keeps the effort and window it can use; the rest go back to its defaults.
  function pickModel(m: CopilotModel): void {
    const keepEffort = value.effort && m.supportedReasoningEfforts.includes(value.effort)
    const keepWindow =
      value.contextTier && m.contextTiers?.some((w) => w.tier === value.contextTier)
    commit({
      model: m.id,
      effort: keepEffort ? value.effort : '',
      autoTier: '',
      contextTier: keepWindow ? value.contextTier : ''
    })
  }

  // Turning Auto off starts from Copilot's first model and opens the list to choose another.
  function toggleAuto(): void {
    if (!isAuto) {
      onChange(AUTO_SELECTION)
      return
    }
    const first = copilot[0] ?? keyModels.find((m) => m.byok?.ready)
    if (!first) return
    onChange({ ...AUTO_SELECTION, model: first.id })
    openFlyout('model')
  }

  const manageKeys = (): void => {
    closeMenu(false)
    onManageKeys?.()
  }

  const into = layout.side === 'right' ? 'ArrowRight' : 'ArrowLeft'
  const back = layout.side === 'right' ? 'ArrowLeft' : 'ArrowRight'

  function onMainKey(event: KeyboardEvent<HTMLDivElement>): void {
    const sub = (document.activeElement as HTMLElement | null)?.dataset.sub as Flyout | undefined
    if (event.key === into && sub) {
      event.preventDefault()
      openFlyout(sub)
      return
    }
    moveMenuFocus(event, '[role^="menuitem"]')
  }

  function onFlyKey(event: KeyboardEvent<HTMLDivElement>): void {
    const inSearch = event.target === searchRef.current
    if (inSearch) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        flyRef.current
          ?.querySelector<HTMLElement>('.mp-list [role^="menuitem"]:not(:disabled)')
          ?.focus()
      } else if (event.key === back && !query) {
        event.preventDefault()
        closeFlyout()
      }
      return
    }
    if (event.key === back) {
      event.preventDefault()
      closeFlyout()
      return
    }
    if (flyout === 'model' && event.key === 'ArrowUp') {
      const items = Array.from(
        flyRef.current?.querySelectorAll<HTMLElement>(
          '.mp-list [role^="menuitem"]:not(:disabled)'
        ) ?? []
      )
      if (items[0] === document.activeElement) {
        event.preventDefault()
        searchRef.current?.focus()
        return
      }
    }
    moveMenuFocus(event, '.mp-list [role^="menuitem"], .mp-fly-items [role^="menuitem"]')
  }

  const subRow = (kind: Flyout, name: string, current: ReactNode): JSX.Element => (
    <button
      key={kind}
      type="button"
      role="menuitem"
      aria-haspopup="menu"
      aria-expanded={flyout === kind}
      data-sub={kind}
      className={`mp-item mp-sub${flyout === kind ? ' is-open' : ''}`}
      onClick={() => (flyout === kind ? closeFlyout() : openFlyout(kind))}
    >
      <span className="mp-item-label">{name}</span>
      <span className="mp-sub-value">{current}</span>
      <Codicon name="chevron-right" className="mp-caret" />
    </button>
  )

  const modelRow = (m: CopilotModel): JSX.Element => {
    const on = value.model === m.id
    const blocked = Boolean(m.byok && !m.byok.ready)
    return (
      <button
        key={m.id}
        type="button"
        role="menuitemradio"
        aria-checked={on}
        disabled={blocked}
        className="mp-item mp-model"
        title={
          blocked
            ? m.byok?.note
            : m.byok
              ? `Runs on your ${m.byok.providerName} API key`
              : undefined
        }
        onClick={() => pickModel(m)}
      >
        <ModelLogo model={m} className="mp-logo" />
        <span className="mp-item-text">
          <span className="mp-item-label">{m.name}</span>
          {blocked && m.byok?.note && <span className="mp-item-desc">{m.byok.note}</span>}
        </span>
        {m.byok ? (
          <span className="mp-tag">
            <Codicon name="key" />
            {m.byok.providerName}
          </span>
        ) : (
          isFastModel(m) && <span className="mp-badge">Fast</span>
        )}
        <Codicon name="check" className={`mp-check${on ? '' : ' mp-check--off'}`} />
      </button>
    )
  }

  const q = query.trim().toLowerCase()
  const results = q
    ? models.filter((m) =>
        `${m.name} ${m.id} ${m.vendor ?? ''} ${m.byok?.providerName ?? ''}`
          .toLowerCase()
          .includes(q)
      )
    : []

  const modelFlyout = (
    <>
      <div className="mp-search">
        <Codicon name="search" className="mp-search-icon" />
        <input
          ref={searchRef}
          type="text"
          className="mp-search-input"
          placeholder="Search models"
          aria-label="Search models"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="mp-list">
        {q ? (
          results.map(modelRow)
        ) : (
          <>
            {missing && (
              <button
                type="button"
                role="menuitemradio"
                aria-checked
                disabled
                className="mp-item mp-model"
              >
                <Codicon name="warning" className="mp-logo mp-warn" />
                <span className="mp-item-text">
                  <span className="mp-item-label">{missingName(value.model)}</span>
                  <span className="mp-item-desc">Not available anymore. Choose another model.</span>
                </span>
              </button>
            )}
            {featured.map(modelRow)}
            {keyModels.length > 0 && (
              <div className="mp-group" role="group" aria-label="Your API keys">
                <div className="mp-heading" aria-hidden="true">
                  Your API keys
                </div>
                {keyModels.map(modelRow)}
              </div>
            )}
            {onManageKeys && keyModels.length === 0 && models.length > 0 && (
              <button
                type="button"
                role="menuitem"
                className="mp-item mp-quiet"
                onClick={manageKeys}
              >
                <Codicon name="key" className="mp-logo" />
                <span className="mp-item-label">Add models with your API keys…</span>
              </button>
            )}
            {more.length > 0 &&
              (showMore ? (
                <div className="mp-group" role="group" aria-label="More models">
                  <div className="mp-heading" aria-hidden="true">
                    More models
                  </div>
                  {more.map(modelRow)}
                </div>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  className="mp-item mp-more"
                  onClick={() => {
                    setShowMore(true)
                    requestAnimationFrame(() =>
                      flyRef.current
                        ?.querySelector<HTMLElement>(
                          '[aria-label="More models"] [role^="menuitem"]'
                        )
                        ?.focus()
                    )
                  }}
                >
                  <span className="mp-item-label">More models</span>
                  <span className="mp-count">{more.length}</span>
                  <Codicon name="chevron-down" className="mp-caret" />
                </button>
              ))}
          </>
        )}
        {loading && models.length === 0 && (
          <div className="mp-empty shimmer-text">Loading models…</div>
        )}
        {!loading && models.length === 0 && (
          <div className="mp-empty">
            Couldn’t load the models. Close this and open it again to retry.
          </div>
        )}
        {q && results.length === 0 && models.length > 0 && (
          <div className="mp-empty">No models match “{query.trim()}”</div>
        )}
      </div>
    </>
  )

  const effortFlyout = (
    <div className="mp-fly-items">
      {!defaultEffort && (
        <button
          type="button"
          role="menuitemradio"
          aria-checked={!value.effort}
          className="mp-item"
          onClick={() => commit({ ...value, effort: '' })}
        >
          <span className="mp-item-text">
            <span className="mp-item-label">Automatic</span>
            <span className="mp-item-desc">The model decides how long to think.</span>
          </span>
          <Codicon name="check" className={`mp-check${value.effort ? ' mp-check--off' : ''}`} />
        </button>
      )}
      {efforts.map((e) => (
        <button
          key={e}
          type="button"
          role="menuitemradio"
          aria-checked={effort === e}
          className="mp-item"
          onClick={() => commit({ ...value, effort: e === defaultEffort ? '' : e })}
        >
          <span className="mp-item-text">
            <span className="mp-item-label">
              {EFFORT_LABEL[e].label}
              {e === defaultEffort && <span className="mp-badge mp-badge--inline">Default</span>}
            </span>
            <span className="mp-item-desc">{EFFORT_LABEL[e].hint}</span>
          </span>
          <Codicon name="check" className={`mp-check${effort === e ? '' : ' mp-check--off'}`} />
        </button>
      ))}
    </div>
  )

  const contextFlyout = (
    <div className="mp-fly-items">
      {windows.map((w) => {
        const on = (value.contextTier || 'default') === w.tier
        return (
          <button
            key={w.tier}
            type="button"
            role="menuitemradio"
            aria-checked={on}
            className="mp-item"
            onClick={() => commit({ ...value, contextTier: w.tier === 'default' ? '' : w.tier })}
          >
            <span className="mp-item-label">{CONTEXT_NAME[w.tier] ?? w.tier}</span>
            <span className="mp-sub-value">{formatTokens(w.tokens)} tokens</span>
            <Codicon name="check" className={`mp-check${on ? '' : ' mp-check--off'}`} />
          </button>
        )
      })}
      <p className="mp-note">A long window keeps more of your app and the conversation in view.</p>
    </div>
  )

  return (
    <div
      ref={rootRef}
      className="composer-menu model-picker"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return
        event.preventDefault()
        event.stopPropagation()
        if (flyout) closeFlyout()
        else closeMenu()
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`composer-pill mp-pill${open ? ' is-open' : ''}`}
        title={
          disabled
            ? 'The model can’t be changed while the assistant is working'
            : `${label}: ${pillText}${selected?.byok ? ` — on your ${selected.byok.providerName} API key` : ''}`
        }
        onClick={() => (open ? closeMenu(false) : openMenu())}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}: ${pillText}`}
      >
        {selected && <ModelLogo model={selected} className="mp-pill-logo" />}
        {missing && <Codicon name="warning" className="mp-pill-warn" />}
        {/* In a narrow composer the logo (or warning) stands in for the name; Auto keeps its label. */}
        <span className={`composer-pill-label${selected || missing ? ' composer-pill-label--model' : ''}`}>
          {pillText}
        </span>
        {selected?.byok && <Codicon name="key" className="mp-pill-key" />}
        <Codicon name="chevron-down" className="composer-pill-caret" />
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className={`mp-pop mp-pop--${placement} mp-pop--${layout.side}`}
            style={layout.style}
          >
            <div
              className="mp-panel mp-main"
              role="menu"
              aria-label={label}
              ref={mainRef}
              onKeyDown={onMainKey}
            >
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={isAuto}
                className="mp-item mp-auto"
                disabled={isAuto && models.length === 0 && loading}
                onClick={toggleAuto}
              >
                <span className="mp-item-text">
                  <span className="mp-item-label">Auto</span>
                  <span className="mp-item-desc">
                    {autoHint ?? 'Copilot picks the model for each request.'}
                  </span>
                </span>
                <span
                  className={`switch switch--sm${isAuto ? ' switch--on' : ''}`}
                  aria-hidden="true"
                >
                  <span className="switch-knob" />
                </span>
              </button>
              {isAuto && tiers && autoTiers && (
                <div className="mp-group" role="group" aria-label="Optimized for">
                  <div className="mp-heading" aria-hidden="true">
                    Optimized for
                  </div>
                  {autoTiers.tiers.map((t) => {
                    const on = activeTier === t.id
                    const desc = t.enabled ? t.description : t.note || t.description
                    return (
                      <button
                        key={t.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={on}
                        disabled={!t.enabled}
                        className="mp-item"
                        onClick={() => commit({ ...AUTO_SELECTION, autoTier: t.id })}
                      >
                        <span className="mp-item-text">
                          <span className="mp-item-label">{t.name}</span>
                          {desc && <span className="mp-item-desc">{desc}</span>}
                        </span>
                        <Codicon name="check" className={`mp-check${on ? '' : ' mp-check--off'}`} />
                      </button>
                    )
                  })}
                </div>
              )}
              {!isAuto && (
                <div className="mp-group">
                  {subRow(
                    'model',
                    'Model',
                    <>
                      {selected && <ModelLogo model={selected} className="mp-logo" />}
                      <span className="mp-sub-text">
                        {selected?.name ?? missingName(value.model)}
                      </span>
                    </>
                  )}
                  {efforts.length > 0 &&
                    subRow('effort', 'Effort', effort ? EFFORT_LABEL[effort].label : 'Automatic')}
                  {windows.length > 1 &&
                    activeWindow &&
                    subRow('context', 'Context window', formatTokens(activeWindow.tokens))}
                </div>
              )}
              {onManageKeys && (
                <>
                  <div className="mp-sep" role="separator" />
                  <button
                    type="button"
                    role="menuitem"
                    className="mp-item mp-quiet"
                    onClick={manageKeys}
                  >
                    <Codicon name="key" className="mp-logo" />
                    <span className="mp-item-label">Manage API keys…</span>
                  </button>
                </>
              )}
            </div>
            {flyout && (
              <div
                className={`mp-panel mp-fly mp-fly--${flyout}`}
                role="menu"
                aria-label={
                  flyout === 'model' ? 'Models' : flyout === 'effort' ? 'Effort' : 'Context window'
                }
                ref={flyRef}
                onKeyDown={onFlyKey}
              >
                {flyout === 'model'
                  ? modelFlyout
                  : flyout === 'effort'
                    ? effortFlyout
                    : contextFlyout}
              </div>
            )}
          </div>,
          document.body
        )}
    </div>
  )
}
