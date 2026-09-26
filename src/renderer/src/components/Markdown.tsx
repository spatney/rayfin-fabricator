import {
  Children,
  createContext,
  isValidElement,
  memo,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { highlightCode } from '../syntax'
import { Codicon } from './icons'
import './markdown.css'

/**
 * Lets Markdown inside the chat turn project file references — inline code
 * like `src/App.tsx` or relative links — into links that open the Code tab.
 * Without a provider (Advisor, Plan cards) references render as plain code.
 */
export interface MarkdownLinks {
  resolveFile: (text: string) => string | null
  openFile: (path: string) => void
}

export const MarkdownLinksContext = createContext<MarkdownLinks | null>(null)

/** Code blocks longer than this start collapsed. */
const COLLAPSE_AFTER_LINES = 18

/** Pull the raw text + language hint out of a fenced/indented code block. */
function extractCode(children: ReactNode): { text: string; lang?: string } {
  const child = Array.isArray(children) ? children[0] : children
  if (isValidElement(child)) {
    const props = child.props as { className?: string; children?: ReactNode }
    const lang = /language-([\w+-]+)/.exec(props.className ?? '')?.[1]
    return { text: String(props.children ?? '').replace(/\n+$/, ''), lang }
  }
  return { text: String(child ?? '').replace(/\n+$/, '') }
}

function CodeBlock({ text, lang }: { text: string; lang?: string }): JSX.Element {
  const lines = text.split('\n').length
  const [copied, setCopied] = useState(false)
  const [wrap, setWrap] = useState(false)
  // A little slack so a block just over the limit doesn't hide one line.
  const [expanded, setExpanded] = useState(lines <= COLLAPSE_AFTER_LINES + 4)
  const timer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current)
    },
    []
  )
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      if (timer.current != null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1200)
    } catch {
      /* clipboard unavailable — ignore */
    }
  }
  const hl = highlightCode(text, lang)
  return (
    <div className={`md-codeblock${wrap ? ' is-wrap' : ''}${expanded ? '' : ' is-collapsed'}`}>
      <div className="md-codeblock-head">
        <span className="md-codeblock-lang">{hl?.label ?? lang ?? 'text'}</span>
        <span className="md-codeblock-tools">
          <button
            type="button"
            className={`md-codeblock-btn${wrap ? ' is-on' : ''}`}
            onClick={() => setWrap((w) => !w)}
            aria-pressed={wrap}
            title={wrap ? 'Don’t wrap long lines' : 'Wrap long lines'}
            aria-label="Wrap long lines"
          >
            <Codicon name="word-wrap" />
          </button>
          <button
            type="button"
            className="md-codeblock-btn"
            onClick={copy}
            title="Copy code"
            aria-label="Copy code"
          >
            <Codicon name={copied ? 'check' : 'copy'} /> {copied ? 'Copied' : 'Copy'}
          </button>
        </span>
      </div>
      <pre className="md-codeblock-pre">
        {hl ? (
          <code className="hljs" dangerouslySetInnerHTML={{ __html: hl.html }} />
        ) : (
          <code className="hljs">{text}</code>
        )}
      </pre>
      {!expanded && (
        <button type="button" className="md-codeblock-more" onClick={() => setExpanded(true)}>
          Show all {lines} lines
        </button>
      )}
    </div>
  )
}

const CALLOUTS = {
  note: { title: 'Note', icon: 'info' },
  tip: { title: 'Tip', icon: 'lightbulb' },
  important: { title: 'Important', icon: 'report' },
  warning: { title: 'Warning', icon: 'warning' },
  caution: { title: 'Caution', icon: 'error' }
} as const

type CalloutKind = keyof typeof CALLOUTS
const CALLOUT_RE = /^\s*\[!(note|tip|important|warning|caution)\]\s*/i

/** GitHub alert syntax (`> [!NOTE]`) → a callout; ordinary quotes pass through. */
function Blockquote({ children }: { children?: ReactNode }): JSX.Element {
  const kids = Children.toArray(children).filter((c) => !(typeof c === 'string' && !c.trim()))
  const first = kids[0]
  if (isValidElement(first)) {
    const para = first as ReactElement<{ children?: ReactNode }>
    const parts = Children.toArray(para.props.children)
    const head = parts[0]
    const m = typeof head === 'string' ? CALLOUT_RE.exec(head) : null
    if (m) {
      const kind = m[1].toLowerCase() as CalloutKind
      const rest = [(head as string).slice(m[0].length), ...parts.slice(1)].filter(
        (p) => !(typeof p === 'string' && !p.trim())
      )
      return (
        <div className={`md-callout md-callout--${kind}`} role="note">
          <div className="md-callout-title">
            <Codicon name={CALLOUTS[kind].icon} /> {CALLOUTS[kind].title}
          </div>
          {rest.length > 0 && <p>{rest}</p>}
          {kids.slice(1)}
        </div>
      )
    }
  }
  return <blockquote>{children}</blockquote>
}

function InlineCode({ children }: { children?: ReactNode }): JSX.Element {
  const links = useContext(MarkdownLinksContext)
  const text = Children.toArray(children).join('')
  const file = links?.resolveFile(text)
  if (links && file) {
    return (
      <button
        type="button"
        className="md-code-inline md-file-link"
        onClick={() => links.openFile(file)}
        title={`Open ${file} in the Code tab`}
      >
        {text}
      </button>
    )
  }
  return <code className="md-code-inline">{children}</code>
}

function Link({ href, children }: { href?: string; children?: ReactNode }): JSX.Element {
  const links = useContext(MarkdownLinksContext)
  const relative = Boolean(href) && !/^[a-z][a-z0-9+.-]*:/i.test(href!) && !href!.startsWith('#')
  const file = relative ? links?.resolveFile(decodeURIComponent(href!)) : null
  return (
    <a
      href={href}
      title={file ? `Open ${file} in the Code tab` : href}
      onClick={(e) => {
        e.preventDefault()
        if (file) links?.openFile(file)
        else if (href) void window.api.openExternal(href)
      }}
    >
      {children}
    </a>
  )
}

const components: Components = {
  // Open links in the user's default browser (or project files in the Code tab).
  a({ href, children }) {
    return <Link href={href}>{children}</Link>
  },
  blockquote({ children }) {
    return <Blockquote>{children}</Blockquote>
  },
  // Wide tables scroll inside their own frame instead of the whole message.
  table({ children }) {
    return (
      <div className="md-table-wrap">
        <table>{children}</table>
      </div>
    )
  },
  // Fenced/indented code → styled block with copy / wrap / collapse. The inner
  // `code` element is not rendered here, so the `code` override below only
  // affects inline code.
  pre({ children }) {
    const { text, lang } = extractCode(children)
    return <CodeBlock text={text} lang={lang} />
  },
  code({ children }) {
    return <InlineCode>{children}</InlineCode>
  }
}

/** Render assistant chat text as sanitized GitHub-flavored markdown. */
function Markdown({ children }: { children: string }): JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  )
}

// Memoized: assistant turns re-render on every streamed token, but a given text
// segment's markdown only needs re-parsing when its own string changes. Skipping
// unchanged segments avoids re-running react-markdown + highlight.js needlessly.
export default memo(Markdown)
