import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { ChatMode, CopilotModel, ReasoningEffort } from '@shared/ipc'
import { isFastModel, useCopilotModels } from '@renderer/copilotModels'
import { Codicon, ImageIcon } from '../icons'
import { ModeIcon } from './icons'
import { EFFORT_OPTIONS, EFFORT_ORDER, MODES } from './modes'

/** Open/close state for a composer popover that closes on any outside click. */
function usePopover(): [boolean, (open: boolean | ((o: boolean) => boolean)) => void] {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const close = (): void => setOpen(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [open])
  return [open, setOpen]
}

/** Arrow / Home / End navigation across a menu's items. */
function moveFocus(e: KeyboardEvent<HTMLElement>, selector: string): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>(selector)).filter(
    (b) => !b.disabled
  )
  if (!items.length) return
  e.preventDefault()
  const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement))
  const next =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? items.length - 1
        : e.key === 'ArrowDown'
          ? (current + 1) % items.length
          : (current - 1 + items.length) % items.length
  items[next].focus()
}

/** Agent / Plan / Autopilot selector (experimental). */
export function ModeMenu({
  mode,
  disabled,
  onSelect
}: {
  mode: ChatMode
  disabled: boolean
  onSelect: (mode: ChatMode) => void
}): JSX.Element {
  const [open, setOpen] = usePopover()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const current = MODES.find((m) => m.id === mode) ?? MODES[0]

  useEffect(() => {
    if (!open) return
    const id = requestAnimationFrame(() => {
      menuRef.current
        ?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')
        ?.focus()
    })
    return () => cancelAnimationFrame(id)
  }, [open])

  const close = (): void => {
    setOpen(false)
    requestAnimationFrame(() => triggerRef.current?.focus())
  }

  return (
    <div
      className="composer-menu"
      ref={menuRef}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.preventDefault()
          close()
          return
        }
        if (open) moveFocus(e, '[role="menuitemradio"]')
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`composer-pill${open ? ' is-open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title={current.hint}
      >
        <ModeIcon mode={mode} className="composer-pill-icon" />
        <span className="composer-pill-label">{current.label}</span>
        <Codicon name="chevron-down" className="composer-pill-caret" />
      </button>
      {open && (
        <div className="composer-pop" role="menu">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="menuitemradio"
              aria-checked={mode === m.id}
              className={`composer-opt${mode === m.id ? ' is-on' : ''}`}
              onClick={() => {
                onSelect(m.id)
                close()
              }}
            >
              <ModeIcon mode={m.id} className="composer-opt-icon" />
              <span className="composer-opt-text">
                <span className="composer-opt-label">{m.label}</span>
                <span className="composer-opt-desc">{m.desc}</span>
              </span>
              {mode === m.id && <Codicon name="check" className="composer-opt-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Display names for reasoning efforts; short forms fit the composer pill. */
const EFFORT_LABEL: Record<ReasoningEffort, { label: string; short: string; hint: string }> = {
  none: { label: 'None', short: 'None', hint: 'Answers without extra thinking.' },
  low: { label: 'Low', short: 'Low', hint: 'Quick — fine for small, clear changes.' },
  medium: { label: 'Medium', short: 'Med', hint: 'Balanced speed and care.' },
  high: { label: 'High', short: 'High', hint: 'Thinks longer — good for tricky changes.' },
  xhigh: { label: 'Extra high', short: 'XHigh', hint: 'Thinks much longer on hard problems.' },
  max: { label: 'Max', short: 'Max', hint: 'The most thinking — slowest, for the hardest work.' }
}

/** The model family a model belongs to, for grouping a long list. */
function modelFamily(m: CopilotModel): string {
  const id = m.id.toLowerCase()
  if (id.startsWith('claude')) return 'Anthropic'
  if (id.startsWith('gpt') || /^o\d/.test(id)) return 'OpenAI'
  if (id.startsWith('gemini')) return 'Google'
  if (id.startsWith('grok')) return 'xAI'
  if (id.startsWith('mai')) return 'Microsoft'
  return 'Other'
}

/** Show a filter box once the list is long enough to need one. */
const FILTER_AFTER = 8

/**
 * Model + reasoning-effort picker: a scrollable list of models (grouped by
 * family, with a filter when long) and effort as a segmented control. Loads
 * the model list the first time it opens.
 */
export function ModelMenu({
  model,
  effort,
  disabled,
  onChange
}: {
  model: string
  effort: ReasoningEffort | ''
  disabled: boolean
  onChange: (model: string, effort: ReasoningEffort | '') => void
}): JSX.Element {
  const [open, setOpen] = usePopover()
  const [query, setQuery] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const { models, loading } = useCopilotModels(open)
  const selected = useMemo(() => models.find((m) => m.id === model), [models, model])

  // The chosen model's efforts, or — on Auto — the union across all models (an
  // effort still rides along with whatever the engine picks).
  const effortOptions = useMemo<ReasoningEffort[]>(() => {
    let efforts: ReasoningEffort[]
    if (selected) efforts = selected.supportedReasoningEfforts
    else {
      const set = new Set<ReasoningEffort>()
      for (const m of models) for (const e of m.supportedReasoningEfforts) set.add(e)
      efforts = [...set]
    }
    if (efforts.length === 0 && models.length === 0) efforts = EFFORT_OPTIONS
    return EFFORT_ORDER.filter((e) => efforts.includes(e))
  }, [models, selected])

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const shown = q ? models.filter((m) => `${m.name} ${m.id}`.toLowerCase().includes(q)) : models
    const byFamily = new Map<string, CopilotModel[]>()
    for (const m of shown) {
      const family = modelFamily(m)
      byFamily.set(family, [...(byFamily.get(family) ?? []), m])
    }
    return [...byFamily.entries()]
  }, [models, query])

  useEffect(() => {
    if (!open) {
      setQuery('')
      return
    }
    const id = requestAnimationFrame(() => {
      const list = listRef.current
      const current = list?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
      current?.scrollIntoView({ block: 'nearest' })
      const filter = list?.parentElement?.querySelector<HTMLInputElement>('.model-filter')
      ;(filter ?? current)?.focus()
    })
    return () => cancelAnimationFrame(id)
  }, [open])

  // Switching model drops an effort the new model can't use back to Auto, so an
  // unsupported model/effort pair is never sent.
  const selectModel = (next: string): void => {
    const m = models.find((x) => x.id === next)
    const stillValid = !effort || !m || m.supportedReasoningEfforts.includes(effort)
    onChange(next, stillValid ? effort : '')
  }

  const label = selected?.name || model || 'Auto'
  const defaultEffort = selected?.defaultReasoningEffort
  const effortHint = effort
    ? EFFORT_LABEL[effort].hint
    : defaultEffort
      ? `Uses the model's default (${EFFORT_LABEL[defaultEffort].label.toLowerCase()}).`
      : 'Lets the model decide how long to think.'
  const savedMissing = Boolean(model) && models.length > 0 && !selected
  const option = (id: string, name: string, badge?: string): JSX.Element => (
    <button
      key={id || 'auto'}
      type="button"
      role="option"
      aria-selected={model === id}
      className={`model-opt${model === id ? ' is-on' : ''}`}
      onClick={() => selectModel(id)}
    >
      <span className="model-opt-name">{name}</span>
      {badge && <span className="model-opt-badge">{badge}</span>}
      {model === id && <Codicon name="check" className="model-opt-check" />}
    </button>
  )

  return (
    <div
      className="composer-menu"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.preventDefault()
          setOpen(false)
          requestAnimationFrame(() => triggerRef.current?.focus())
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`composer-pill${open ? ' is-open' : ''}`}
        title={
          disabled
            ? 'The model can’t be changed while the assistant is working'
            : `Model: ${label} — choose the AI model and reasoning effort`
        }
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Model: ${label}${effort ? `, ${EFFORT_LABEL[effort].label} effort` : ''}`}
      >
        <span className="composer-pill-label composer-pill-label--model">{label}</span>
        {effort && <span className="composer-pill-tag">{EFFORT_LABEL[effort].short}</span>}
        <Codicon name="chevron-down" className="composer-pill-caret" />
      </button>
      {open && (
        <div className="composer-pop model-pop" role="dialog" aria-label="Model settings">
          <div className="model-pop-section">
            <div className="model-pop-label">Model</div>
            {models.length > FILTER_AFTER && (
              <input
                className="model-filter"
                type="search"
                placeholder="Find a model…"
                aria-label="Find a model"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    listRef.current?.querySelector<HTMLButtonElement>('[role="option"]')?.focus()
                  }
                }}
              />
            )}
            <div
              className="model-list"
              role="listbox"
              aria-label="Model"
              ref={listRef}
              onKeyDown={(e) => moveFocus(e, '[role="option"]')}
            >
              {!query && option('', 'Auto', 'Recommended')}
              {savedMissing && !query && option(model, model, 'Unavailable')}
              {groups.map(([family, list]) => (
                <div key={family} className="model-group" role="group" aria-label={family}>
                  {groups.length > 1 && <div className="model-group-label">{family}</div>}
                  {list.map((m) => option(m.id, m.name, isFastModel(m) ? 'Fast' : undefined))}
                </div>
              ))}
              {loading && models.length === 0 && (
                <div className="model-empty shimmer-text">Loading models…</div>
              )}
              {!loading && query && groups.length === 0 && (
                <div className="model-empty">No models match “{query}”</div>
              )}
            </div>
          </div>
          {effortOptions.length > 0 && (
            <div className="model-pop-section model-pop-section--effort">
              <div className="model-pop-label">Reasoning effort</div>
              <div
                className="effort-seg"
                role="radiogroup"
                aria-label="Reasoning effort"
                onKeyDown={(e) => moveFocus(e, '[role="radio"]')}
              >
                {(['', ...effortOptions] as (ReasoningEffort | '')[]).map((e) => (
                  <button
                    key={e || 'auto'}
                    type="button"
                    role="radio"
                    aria-checked={effort === e}
                    className={`effort-opt${effort === e ? ' is-on' : ''}`}
                    onClick={() => onChange(model, e)}
                    title={e ? EFFORT_LABEL[e].hint : 'Let the model decide'}
                  >
                    {e ? EFFORT_LABEL[e].short : 'Auto'}
                  </button>
                ))}
              </div>
              <p className="model-pop-hint">{effortHint}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** The composer's "+" menu: attach an image, connect a semantic model, or reference a file. */
export function AddMenu({
  locked,
  attaching,
  onImage,
  onConnectModel,
  onReferenceFile
}: {
  /** The project has no deployment yet (connecting a model needs a workspace). */
  locked: boolean
  attaching: boolean
  onImage: () => void
  onConnectModel: () => void
  onReferenceFile: () => void
}): JSX.Element {
  const [open, setOpen] = usePopover()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const id = requestAnimationFrame(() =>
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
    )
    return () => cancelAnimationFrame(id)
  }, [open])
  const pick = (action: () => void): void => {
    setOpen(false)
    action()
  }
  return (
    <div
      className="composer-menu"
      ref={menuRef}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.preventDefault()
          setOpen(false)
          requestAnimationFrame(() => triggerRef.current?.focus())
          return
        }
        if (open) moveFocus(e, '[role="menuitem"]')
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`composer-icon-btn${open ? ' is-open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        disabled={locked}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Add images, data, or files"
        title="Add images, data, or files"
      >
        {attaching ? <span className="step-spin" aria-hidden="true" /> : <Codicon name="add" />}
      </button>
      {open && (
        <div className="composer-pop" role="menu">
          <button
            type="button"
            role="menuitem"
            className="composer-opt"
            disabled={attaching || locked}
            onClick={() => pick(onImage)}
          >
            <ImageIcon className="composer-opt-icon" />
            <span className="composer-opt-text">
              <span className="composer-opt-label">Add an image</span>
              <span className="composer-opt-desc">Or paste / drop a screenshot into the box</span>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="composer-opt"
            disabled={locked}
            onClick={() => pick(onConnectModel)}
            title={
              locked
                ? 'Deploy this app to a workspace before connecting a semantic model'
                : undefined
            }
          >
            <Codicon name="database" className="composer-opt-icon" />
            <span className="composer-opt-text">
              <span className="composer-opt-label">Connect a semantic model</span>
              <span className="composer-opt-desc">
                Use data from a Power BI model in your workspace
              </span>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="composer-opt"
            disabled={locked}
            onClick={() => pick(onReferenceFile)}
          >
            <Codicon name="mention" className="composer-opt-icon" />
            <span className="composer-opt-text">
              <span className="composer-opt-label">Reference a file</span>
              <span className="composer-opt-desc">
                Point Fabricator at a file in your project (type @)
              </span>
            </span>
          </button>
        </div>
      )}
    </div>
  )
}
