import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import type { TerminalView } from '../../terminal/session'
import { Codicon } from '../icons'

interface Options {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

const TOGGLES: { option: keyof Options; icon: string; label: string }[] = [
  { option: 'caseSensitive', icon: 'case-sensitive', label: 'Match case' },
  { option: 'wholeWord', icon: 'whole-word', label: 'Match whole word' },
  { option: 'regex', icon: 'regex', label: 'Use regular expression' }
]

/** Find in a terminal's output, scrollback included. Escape gives the keyboard back to the terminal. */
export default function TerminalFind({
  session,
  onClose
}: {
  session: TerminalView
  onClose: () => void
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<Options>({
    caseSensitive: false,
    wholeWord: false,
    regex: false
  })
  const [results, setResults] = useState<{ index: number; count: number } | null>(null)
  const [invalid, setInvalid] = useState(false)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  useEffect(
    () =>
      session.onSearchResults(({ resultIndex, resultCount }) =>
        setResults({ index: resultIndex, count: resultCount })
      ),
    [session]
  )

  // As you type, the nearest match from where you are.
  useEffect(() => {
    if (!query) {
      session.clearSearch()
      setResults(null)
      setInvalid(false)
      return
    }
    try {
      session.findNext(query, { ...options, incremental: true })
      setInvalid(false)
    } catch {
      setInvalid(true)
    }
  }, [query, options, session])

  useEffect(() => () => session.clearSearch(), [session])

  const step = (back: boolean): void => {
    if (!query) return
    try {
      if (back) session.findPrevious(query, options)
      else session.findNext(query, options)
    } catch {
      setInvalid(true)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' || event.key === 'F3') {
      event.preventDefault()
      step(event.shiftKey)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
  }

  const count = invalid
    ? 'Invalid pattern'
    : !query || !results
      ? ''
      : results.count === 0
        ? 'No results'
        : results.index >= 0
          ? `${results.index + 1} of ${results.count}`
          : `${results.count} found`

  return (
    <div className="terminal-find" role="search" aria-label="Find in terminal">
      <input
        ref={inputRef}
        className="terminal-find-input"
        value={query}
        placeholder="Find"
        aria-label="Find in terminal"
        spellCheck={false}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <span className={`terminal-find-count${invalid ? ' terminal-find-count--bad' : ''}`}>
        {count}
      </span>
      {TOGGLES.map(({ option, icon, label }) => (
        <button
          key={option}
          type="button"
          className={`terminal-btn${options[option] ? ' terminal-btn--on' : ''}`}
          aria-pressed={options[option]}
          aria-label={label}
          title={label}
          onClick={() => setOptions((current) => ({ ...current, [option]: !current[option] }))}
        >
          <Codicon name={icon} />
        </button>
      ))}
      <span className="terminal-find-rule" aria-hidden="true" />
      <button
        type="button"
        className="terminal-btn"
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
        disabled={!query}
        onClick={() => step(true)}
      >
        <Codicon name="arrow-up" />
      </button>
      <button
        type="button"
        className="terminal-btn"
        aria-label="Next match"
        title="Next match (Enter)"
        disabled={!query}
        onClick={() => step(false)}
      >
        <Codicon name="arrow-down" />
      </button>
      <button
        type="button"
        className="terminal-btn"
        aria-label="Close find"
        title="Close (Escape)"
        onClick={onClose}
      >
        <Codicon name="close" />
      </button>
    </div>
  )
}
