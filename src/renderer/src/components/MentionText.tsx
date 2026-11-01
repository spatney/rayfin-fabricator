import { Fragment, type JSX } from 'react'

// A file/mockup reference token: "@" followed by a run of non-space, non-"@"
// characters, or a quoted path with spaces (`@"C:\My files\notes.md"`),
// anchored at start-of-string or after whitespace. This mirrors the composer's
// own @-detection (see `activeMention`), so what we highlight matches what the
// picker inserts. Emails ("a@b.com") are not matched because their "@" is not
// preceded by whitespace.
export const MENTION_RE = /(^|\s)(@"[^"\n]+"|@[^\s@"]+)/g

/** Trailing punctuation that ends a sentence rather than a path. */
const TRAILING_PUNCT = /[,:;.!?)\]'"]+$/

/** A path spelled out from somewhere: `./`, `../`, `~/`, `/`, `\` or a drive such as `C:\`. */
const SPELLED_PATH = /^(?:\.{1,2}[\\/]|~[\\/]|[\\/]|[a-z]:[\\/])/i

/** What a reference token names: without its `@`, or the quotes around a path with spaces. */
export function mentionPath(token: string): string {
  const path = token.slice(1)
  return path.startsWith('"') ? path.slice(1, path.endsWith('"') ? -1 : undefined) : path
}

/** A reference to something outside the project (`../`, `~/` or a full path), which the Code tab can't open. */
export function isOutsideReference(token: string): boolean {
  return SPELLED_PATH.test(mentionPath(token)) && !/^\.[\\/]/.test(mentionPath(token))
}

/**
 * A token names a file when it spells out a path, its last segment has an
 * extension, or it nests folders. This keeps npm scopes such as
 * `@microsoft/rayfin-cli` plain.
 */
function isFileToken(token: string): boolean {
  const path = mentionPath(token)
  if (SPELLED_PATH.test(path)) return true
  const last = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  return /\.[a-z0-9]{1,10}$/i.test(last) || (path.match(/[\\/]/g)?.length ?? 0) >= 2
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
    // A quoted path ends at its closing quote: no sentence punctuation to trim.
    const token = m[2].startsWith('@"') ? m[2] : m[2].replace(TRAILING_PUNCT, '')
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
 *  `onOpen` is given, each chip in the project is clickable (opens the
 *  referenced file/mockup); one outside the project is a plain chip. */
export function MentionText({ text, onOpen }: { text: string; onOpen?: (ref: string) => void }): JSX.Element {
  const parts = splitMentions(text)
  return (
    <>
      {parts.map((p, i) =>
        p.mention ? (
          onOpen && !isOutsideReference(p.text) ? (
            <span
              key={i}
              className="chat-mention chat-mention--link"
              role="button"
              tabIndex={0}
              title={`Open ${mentionPath(p.text)}`}
              onClick={() => onOpen(`@${mentionPath(p.text)}`)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onOpen(`@${mentionPath(p.text)}`)
                }
              }}
            >
              {p.text}
            </span>
          ) : (
            <span key={i} className="chat-mention" title={mentionPath(p.text)}>
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
