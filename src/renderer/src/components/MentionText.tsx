import { Fragment } from 'react'

// A file/mockup reference token: "@" followed by a run of non-space, non-"@"
// characters, anchored at start-of-string or after whitespace. This mirrors the
// composer's own @-detection (see `evalAt` in ChatPanel), so what we highlight
// matches what the picker inserts. Emails ("a@b.com") are not matched because
// their "@" is not preceded by whitespace.
export const MENTION_RE = /(^|\s)(@[^\s@]+)/g

/** Trailing punctuation that ends a sentence rather than a path. */
const TRAILING_PUNCT = /[,:;.!?)\]'"]+$/

/**
 * A token names a file when its last segment has an extension or it nests
 * folders. This keeps npm scopes such as `@microsoft/rayfin-cli` plain.
 */
function isFileToken(token: string): boolean {
  const path = token.slice(1)
  const last = path.slice(path.lastIndexOf('/') + 1)
  return /\.[a-z0-9]{1,10}$/i.test(last) || (path.match(/\//g)?.length ?? 0) >= 2
}

export interface MentionPart {
  text: string
  /** True when this part is an `@file`/`@mockup` reference (text includes the `@`). */
  mention: boolean
}

/** Split text into alternating plain + mention parts (mention text keeps its `@`).
 *  `known` (project-relative paths) also accepts extensionless files like `@Dockerfile`. */
export function splitMentions(text: string, known?: ReadonlySet<string>): MentionPart[] {
  const parts: MentionPart[] = []
  let last = 0
  const re = new RegExp(MENTION_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const token = m[2].replace(TRAILING_PUNCT, '')
    if (token.length < 2 || !(isFileToken(token) || known?.has(token.slice(1)))) continue
    const start = m.index + m[1].length
    if (start > last) parts.push({ text: text.slice(last, start), mention: false })
    parts.push({ text: token, mention: true })
    last = start + token.length
  }
  if (last < text.length) parts.push({ text: text.slice(last), mention: false })
  return parts
}

/** Render plain text with `@file`/`@mockup` references as styled chips. When
 *  `onOpen` is given, each chip is clickable (opens the referenced file/mockup). */
export function MentionText({ text, onOpen }: { text: string; onOpen?: (ref: string) => void }): JSX.Element {
  const parts = splitMentions(text)
  return (
    <>
      {parts.map((p, i) =>
        p.mention ? (
          onOpen ? (
            <span
              key={i}
              className="chat-mention chat-mention--link"
              role="button"
              tabIndex={0}
              title={`Open ${p.text.slice(1)}`}
              onClick={() => onOpen(p.text)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onOpen(p.text)
                }
              }}
            >
              {p.text}
            </span>
          ) : (
            <span key={i} className="chat-mention">
              {p.text}
            </span>
          )
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        )
      )}
    </>
  )
}
