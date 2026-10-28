import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import { Codicon } from '../icons'
import { fold } from './rank'
import { Icon, Keys } from './parts'
import type { ItemIcon } from './model'

export interface PanelAction {
  id: string
  title: string
  /** A result's own icon, or a codicon's name. */
  icon: ItemIcon | string
  keys?: string[]
  run: () => void
}

export interface PanelSection {
  title?: string
  actions: PanelAction[]
}

/**
 * What can be done with the result you're on, opened with Ctrl+K (⌘K) as in a
 * launcher: what Enter does first, then the rest. Type to narrow it down; ↑ and ↓
 * choose, Enter runs, and Esc or Ctrl+K closes it.
 */
export function ActionPanel({
  title,
  sections,
  onClose
}: {
  /** What the actions are for. */
  title: string
  sections: PanelSection[]
  onClose: () => void
}): JSX.Element {
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [filter, setFilter] = useState('')
  // The chosen action is kept by what it is, not where it is in the list, so one
  // that comes or goes (Stop answering, once Help is done) never hands the choice
  // to whatever takes its place.
  const [chosenId, setChosenId] = useState<string | null>(null)
  const chosenBy = useRef<'keyboard' | 'pointer'>('keyboard')

  const shown = useMemo(() => {
    const words = fold(filter).split(/\s+/).filter(Boolean)
    return sections
      .map((section) => ({
        ...section,
        actions: section.actions.filter((a) => words.every((w) => fold(a.title).includes(w)))
      }))
      .filter((section) => section.actions.length > 0)
  }, [sections, filter])
  const flat = shown.flatMap((section) => section.actions)
  const current = flat.find((action) => action.id === chosenId) ?? flat[0]
  const at = current ? flat.indexOf(current) : -1
  const optionId = (i: number): string => `${listId}-${i}`

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Keep the action chosen with the keyboard in sight.
  useLayoutEffect(() => {
    if (at < 0 || chosenBy.current !== 'keyboard') return
    document.getElementById(`${listId}-${at}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [at, listId])

  const choose = (action: PanelAction, by: 'keyboard' | 'pointer'): void => {
    chosenBy.current = by
    setChosenId(action.id)
  }

  const run = (action: PanelAction): void => {
    onClose()
    action.run()
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    const mod = (event.ctrlKey || event.metaKey) && !event.altKey
    // Ctrl+J (⌘J) still opens Help, from here too.
    if (mod && event.key.toLowerCase() === 'j') return
    event.stopPropagation()
    if (event.key === 'Escape' || (mod && !event.shiftKey && event.key.toLowerCase() === 'k')) {
      event.preventDefault()
      onClose()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (flat.length) {
        const step = event.key === 'ArrowDown' ? 1 : -1
        choose(flat[(at + step + flat.length) % flat.length], 'keyboard')
      }
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      if (current) run(current)
    } else if (event.key === 'Tab') {
      event.preventDefault()
    }
  }

  return (
    <div className="sl-actions" role="dialog" aria-label="Actions">
      <div className="sl-actions-title">{title}</div>
      <div className="sl-actions-list" id={listId} role="listbox" aria-label="Actions">
        {shown.map((section, s) => (
          <div
            key={section.title ?? s}
            className="sl-actions-group"
            role="group"
            aria-label={section.title ?? title}
          >
            {s > 0 && <div className="sl-actions-sep" aria-hidden="true" />}
            {section.title && (
              <div className="sl-actions-label" aria-hidden="true">
                {section.title}
              </div>
            )}
            {section.actions.map((action) => {
              const i = flat.indexOf(action)
              const isCurrent = action === current
              return (
                <div
                  key={action.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={isCurrent}
                  className={`sl-aitem${isCurrent ? ' is-selected' : ''}`}
                  onPointerMove={() => {
                    if (!isCurrent) choose(action, 'pointer')
                  }}
                  onClick={() => run(action)}
                >
                  {typeof action.icon === 'string' ? (
                    <span className="sl-aitem-ico" aria-hidden="true">
                      <Codicon name={action.icon} />
                    </span>
                  ) : (
                    <Icon icon={action.icon} small />
                  )}
                  <span className="sl-aitem-title">{action.title}</span>
                  {action.keys && <Keys keys={action.keys} />}
                </div>
              )
            })}
          </div>
        ))}
        {flat.length === 0 && <p className="sl-actions-empty">No actions match</p>}
      </div>
      <div className="sl-actions-search">
        <input
          ref={inputRef}
          className="sl-actions-input"
          type="text"
          role="combobox"
          aria-label="Search for actions"
          aria-expanded={flat.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={current ? optionId(at) : undefined}
          placeholder="Search for actions…"
          value={filter}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            setFilter(event.target.value)
            chosenBy.current = 'keyboard'
            setChosenId(null)
          }}
          onKeyDown={onKeyDown}
        />
      </div>
    </div>
  )
}
