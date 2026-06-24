import { isValidElement, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { highlightCode } from '../syntax'

/** Pull the raw text + language hint out of a fenced/indented code block. */
function extractCode(children: ReactNode): { text: string; lang?: string } {
  const child = Array.isArray(children) ? children[0] : children
  if (isValidElement(child)) {
    const props = child.props as { className?: string; children?: ReactNode }
    const lang = /language-(\w+)/.exec(props.className ?? '')?.[1]
    return { text: String(props.children ?? '').replace(/\n+$/, ''), lang }
  }
  return { text: String(child ?? '').replace(/\n+$/, '') }
}

function CodeBlock({ text, lang }: { text: string; lang?: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* clipboard unavailable — ignore */
    }
  }
  const hl = highlightCode(text, lang)
  return (
    <div className="md-codeblock">
      <div className="md-codeblock-head">
        <span className="md-codeblock-lang">{hl?.label ?? lang ?? 'text'}</span>
        <button className="md-codeblock-copy" onClick={copy} title="Copy code">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="md-codeblock-pre">
        {hl ? (
          <code className="hljs" dangerouslySetInnerHTML={{ __html: hl.html }} />
        ) : (
          <code className="hljs">{text}</code>
        )}
      </pre>
    </div>
  )
}

const components: Components = {
  // Open links in the user's default browser instead of navigating the app.
  a({ href, children }) {
    return (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault()
          if (href) void window.api.openExternal(href)
        }}
      >
        {children}
      </a>
    )
  },
  // Fenced/indented code → styled block with a copy button. The inner `code`
  // element is not rendered here, so the `code` override below only affects
  // inline code.
  pre({ children }) {
    const { text, lang } = extractCode(children)
    return <CodeBlock text={text} lang={lang} />
  },
  code({ children }) {
    return <code className="md-code-inline">{children}</code>
  }
}

/** Render assistant chat text as sanitized GitHub-flavored markdown. */
export default function Markdown({ children }: { children: string }): JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  )
}
