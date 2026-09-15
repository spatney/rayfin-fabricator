/**
 * A tiny, dependency-free DAX tokenizer used to syntax-highlight measure
 * expressions in the semantic-model view's DAX popover. It is intentionally
 * lightweight (no Monaco / full grammar) — just enough to colour the parts a
 * reader scans for: function names, table & column references, string/number
 * literals, keywords and comments.
 *
 * `tokenizeDax` returns a flat token list; the view renders each token as a
 * `<span class="dax-{kind}">` (whitespace/plain text render bare).
 */

export type DaxKind =
  | 'fn'
  | 'table'
  | 'col'
  | 'str'
  | 'num'
  | 'kw'
  | 'op'
  | 'paren'
  | 'comment'
  | 'text'

export interface DaxToken {
  text: string
  kind: DaxKind
}

/** Bare control-flow keywords (functions like TRUE()/BLANK() are detected as fn). */
const KEYWORDS = new Set(['VAR', 'RETURN', 'IN', 'NOT', 'AND', 'OR'])

const OP_CHARS = new Set('-+*/=<>&|:.^%!'.split(''))

/**
 * Split a DAX expression into coloured tokens. Unknown / plain runs (including
 * whitespace) come back as `text` so the caller can emit them verbatim.
 */
export function tokenizeDax(src: string): DaxToken[] {
  const tokens: DaxToken[] = []
  const push = (text: string, kind: DaxKind): void => {
    if (text) tokens.push({ text, kind })
  }

  const n = src.length
  let i = 0
  while (i < n) {
    const c = src[i]
    const rest = src.slice(i)

    // Line comment.
    if (c === '/' && src[i + 1] === '/') {
      const m = /^\/\/[^\n]*/.exec(rest)!
      push(m[0], 'comment')
      i += m[0].length
      continue
    }
    // Block comment.
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end + 2
      push(src.slice(i, stop), 'comment')
      i = stop
      continue
    }
    // String literal ("" escapes an inner quote).
    if (c === '"') {
      const m = /^"(?:[^"]|"")*"/.exec(rest)
      if (m) {
        push(m[0], 'str')
        i += m[0].length
        continue
      }
    }
    // Single-quoted table name ('Sales Order'[..]).
    if (c === "'") {
      const m = /^'(?:[^']|'')*'/.exec(rest)
      if (m) {
        push(m[0], 'table')
        i += m[0].length
        continue
      }
    }
    // Bracketed column / measure reference.
    if (c === '[') {
      const end = src.indexOf(']', i + 1)
      const stop = end === -1 ? n : end + 1
      push(src.slice(i, stop), 'col')
      i = stop
      continue
    }
    // Number.
    if (c >= '0' && c <= '9') {
      const m = /^\d+(?:\.\d+)?/.exec(rest)!
      push(m[0], 'num')
      i += m[0].length
      continue
    }
    // Identifier → table (if followed by `[`), function (if followed by `(`),
    // keyword, or plain text.
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)!
      const word = m[0]
      i += word.length
      if (src[i] === '[') {
        push(word, 'table')
        continue
      }
      let j = i
      while (j < n && /\s/.test(src[j])) j++
      if (src[j] === '(') {
        push(word, 'fn')
        continue
      }
      push(word, KEYWORDS.has(word.toUpperCase()) ? 'kw' : 'text')
      continue
    }
    // Parens / argument separators.
    if (c === '(' || c === ')' || c === ',') {
      push(c, 'paren')
      i += 1
      continue
    }
    // Whitespace.
    if (/\s/.test(c)) {
      const m = /^\s+/.exec(rest)!
      push(m[0], 'text')
      i += m[0].length
      continue
    }
    // Operators.
    if (OP_CHARS.has(c)) {
      let j = i
      while (j < n && OP_CHARS.has(src[j])) j++
      push(src.slice(i, j), 'op')
      i = j
      continue
    }
    // Anything else (e.g. `{ } &`), verbatim.
    push(c, 'text')
    i += 1
  }
  return tokens
}
