import type { McpServer, McpTransport } from '@shared/ipc'

/** An environment variable or header read from a pasted configuration. */
export interface ParsedValue {
  name: string
  /** Empty when the configuration has a placeholder to fill in. */
  value: string
}

/** A server read from a pasted configuration, to fill in the server form. */
export interface ParsedServer {
  name: string
  transport: McpTransport
  /** The command and its arguments, as one line. */
  commandLine: string
  url: string
  env: ParsedValue[]
  headers: ParsedValue[]
}

export type ParseResult = { servers: ParsedServer[] } | { error: string }

/** Values the user still has to fill in: `${input:token}`, `<YOUR_KEY>`, `YOUR_API_KEY`… */
const PLACEHOLDER = /\$\{[^}]*\}|<[^<>]+>|\bYOUR[_-][A-Z0-9_-]+|^(?:your|my)[-_ ].*(?:key|token)$/i

/**
 * Splits a command line into the program and its arguments. Double and single
 * quotes group words; backslashes are kept as they are, for Windows paths.
 */
export function splitCommandLine(line: string): string[] {
  const words: string[] = []
  let word = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (const c of line.trim()) {
    if (quote) {
      if (c === quote) quote = null
      else word += c
    } else if (c === '"' || c === "'") {
      quote = c
      started = true
    } else if (/\s/.test(c)) {
      if (started) words.push(word)
      word = ''
      started = false
    } else {
      word += c
      started = true
    }
  }
  if (started) words.push(word)
  return words
}

/** The program and its arguments as one line that {@link splitCommandLine} reads back. */
export function joinCommandLine(command: string, args: readonly string[] = []): string {
  return [command, ...args]
    .map((word) => {
      if (word !== '' && !/[\s"']/.test(word)) return word
      return word.includes('"') && !word.includes("'") ? `'${word}'` : `"${word}"`
    })
    .join(' ')
}

/** What a server runs, or where it is, in a few words. */
export function serverSummary(
  server: Pick<McpServer, 'transport' | 'command' | 'args' | 'url'>
): string {
  if (server.transport === 'stdio') return joinCommandLine(server.command ?? '', server.args ?? [])
  try {
    const url = new URL(server.url ?? '')
    const path = url.pathname === '/' ? '' : url.pathname
    return `${url.host}${path}`
  } catch {
    return server.url ?? ''
  }
}

/** Drops `//` and block comments and trailing commas, outside strings (JSON with comments). */
function stripJsonc(text: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === '\\') out += text[++i] ?? ''
      else if (c === '"') inString = false
    } else if (c === '"') {
      inString = true
      out += c
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
    } else {
      out += c
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}

function parseJson(text: string): unknown {
  const clean = stripJsonc(text).trim()
  try {
    return JSON.parse(clean)
  } catch {
    // A server copied out of an mcpServers block: `"chart": { … }`.
    return JSON.parse(`{${clean.replace(/,\s*$/, '')}}`)
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isServer = (value: unknown): boolean =>
  isObject(value) &&
  (typeof value.command === 'string' ||
    typeof value.url === 'string' ||
    typeof value.serverUrl === 'string' ||
    typeof value.httpUrl === 'string')

/** A readable name from a configuration key or a package: `mcp-server-chart` → Chart. */
export function nameFrom(raw: string): string {
  const base = raw
    .replace(/^@[^/]+\//, '')
    .replace(/@[\w.-]+$/, '')
    .replace(/^(?:mcp[-_ ]?server[-_ ]?|server[-_ ]|mcp[-_ ])/i, '')
    .replace(/(?:[-_ ]mcp(?:[-_ ]server)?|[-_ ]server)$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim()
  const name = base || raw.trim()
  return /[A-Z]/.test(name) ? name : name.charAt(0).toUpperCase() + name.slice(1)
}

/** A name for a server from where it is: `learn.microsoft.com` → Learn. */
function nameFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^(?:www|api|mcp)\./, '')
    const parts = host.split('.')
    return nameFrom(parts.length > 2 ? parts[0] : (parts[parts.length - 2] ?? host))
  } catch {
    return 'MCP server'
  }
}

/** Programs that run a package, whose first plain argument names the server. */
const RUNNER = /^(?:npx|pnpx|bunx|uvx|pipx|docker|deno|node|python3?|uv)(?:\.cmd|\.exe)?$/i
const RUNNER_VERBS = new Set(['run', 'exec', 'dlx', 'x', 'tool'])

/** A name for a command server from its package or program: `npx -y @antv/mcp-server-chart` → Chart. */
function nameFromCommand(words: string[]): string {
  const target = RUNNER.test(words[0] ?? '')
    ? words.slice(1).find((w) => !w.startsWith('-') && !RUNNER_VERBS.has(w))
    : words[0]
  if (!target) return 'MCP server'
  if (target.startsWith('@')) return nameFrom(target)
  const last = target.split(/[\\/]/).filter(Boolean).pop() ?? target
  return nameFrom(last.replace(/\.(?:exe|cmd|js|mjs|py)$/i, ''))
}

function values(raw: unknown): ParsedValue[] {
  if (!isObject(raw)) return []
  return Object.entries(raw).map(([name, value]) => {
    const text = typeof value === 'string' ? value : value == null ? '' : String(value)
    return { name, value: PLACEHOLDER.test(text) ? '' : text }
  })
}

function serverFrom(name: string | undefined, raw: Record<string, unknown>): ParsedServer {
  const url =
    [raw.url, raw.serverUrl, raw.httpUrl].find((u): u is string => typeof u === 'string') ?? ''
  const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : ''
  const args = Array.isArray(raw.args) ? raw.args.map(String) : []
  const command = typeof raw.command === 'string' ? raw.command : ''
  const transport: McpTransport =
    command && type !== 'http' && type !== 'sse'
      ? 'stdio'
      : type === 'sse' || (!type && /\/sse\/?$/i.test(url))
        ? 'sse'
        : 'http'
  if (transport === 'stdio') {
    return {
      name: name ? nameFrom(name) : nameFromCommand([command, ...args]),
      transport,
      commandLine: joinCommandLine(command, args),
      url: '',
      env: values(raw.env),
      headers: []
    }
  }
  return {
    name: name ? nameFrom(name) : nameFromUrl(url),
    transport,
    commandLine: '',
    url,
    env: [],
    headers: values(raw.headers)
  }
}

const UNREADABLE =
  'That isn’t a configuration Fabricator can read. Paste the JSON from the server’s instructions.'

/**
 * Reads the servers in a configuration pasted from a server's instructions:
 * JSON (with comments) as Claude, Cursor, VS Code or Copilot CLI take it, one
 * server's entry, a command line, or a URL.
 */
export function parseConfig(text: string): ParseResult {
  const trimmed = text.trim()
  if (!trimmed) return { error: 'Paste a configuration first.' }
  if (/^https?:\/\/\S+$/i.test(trimmed)) {
    return { servers: [serverFrom(undefined, { url: trimmed })] }
  }
  if (!/^[{"]/.test(trimmed)) {
    const words = splitCommandLine(trimmed)
    return { servers: [serverFrom(undefined, { command: words[0], args: words.slice(1) })] }
  }
  let parsed: unknown
  try {
    parsed = parseJson(trimmed)
  } catch {
    return { error: UNREADABLE }
  }
  if (!isObject(parsed)) return { error: UNREADABLE }
  if (isServer(parsed)) {
    const name = typeof parsed.name === 'string' ? parsed.name : undefined
    return { servers: [serverFrom(name, parsed)] }
  }
  const mcp = isObject(parsed.mcp) ? parsed.mcp : undefined
  const map = [parsed.mcpServers, parsed.servers, mcp?.servers, parsed].find(
    (candidate): candidate is Record<string, unknown> =>
      isObject(candidate) && Object.values(candidate).some(isServer)
  )
  if (!map) return { error: 'That configuration doesn’t have a server with a command or a URL.' }
  const servers = Object.entries(map)
    .filter((entry): entry is [string, Record<string, unknown>] => isServer(entry[1]))
    .map(([name, server]) => serverFrom(name, server))
  return { servers }
}
