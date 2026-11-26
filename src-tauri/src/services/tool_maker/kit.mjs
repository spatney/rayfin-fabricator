// Fabricator's tool kit. It runs a tool you made with Copilot as an MCP
// server, over standard input and output, so the tool's own file only defines
// its tools:
//
//   import { serve } from './kit.mjs'
//   serve({ name: 'my-tool', tools: [{ name, description, input, readOnly, run }] })
//
// Fabricator writes this file beside the tool's server.mjs, and replaces it
// when it saves the tool, so don't change it.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'

/** MCP versions the kit speaks: tools work the same in each. */
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const LATEST = '2025-06-18'
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/
/** Marks what tool.text() and tool.image() make. */
const CONTENT = Symbol('content')

// Standard output carries the protocol, so anything else written to it, such
// as console.log, goes to standard error, which Fabricator logs.
const out = process.stdout.write.bind(process.stdout)
process.stdout.write = (chunk, ...rest) => process.stderr.write(chunk, ...rest)

function send(message) {
  out(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
}

function messageOf(error) {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause instanceof Error ? error.cause.message : ''
  return cause && !error.message.includes(cause) ? `${error.message} (${cause})` : error.message
}

/** The tools, checked: a mistake stops the server with what to fix. */
function checked(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error('serve() needs `tools`: an array with at least one tool.')
  }
  const names = new Set()
  return tools.map((tool, i) => {
    const which = typeof tool?.name === 'string' && tool.name ? `The tool ${tool.name}` : `Tool ${i + 1}`
    if (!tool || typeof tool !== 'object') throw new Error(`${which} isn't an object.`)
    if (typeof tool.name !== 'string' || !TOOL_NAME.test(tool.name)) {
      throw new Error(`${which}: its name must be 1 to 64 letters, digits, _ or -.`)
    }
    if (names.has(tool.name)) throw new Error(`There are two tools named ${tool.name}.`)
    names.add(tool.name)
    if (typeof tool.description !== 'string' || !tool.description.trim()) {
      throw new Error(`${which} needs a description.`)
    }
    if (typeof tool.run !== 'function') throw new Error(`${which} needs a run(args, tool) function.`)
    const input = tool.input ?? { type: 'object', properties: {} }
    if (!input || typeof input !== 'object' || input.type !== 'object') {
      throw new Error(`${which}: input must be a JSON Schema with type "object".`)
    }
    return { ...tool, input }
  })
}

/** `path` in the app's `folder`, or an error that says why it isn't. */
function inside(folder, path) {
  if (typeof path !== 'string' || !path.trim()) {
    throw new Error('Give a path in the app, such as public/images/picture.png.')
  }
  const target = resolve(folder, path)
  const rel = relative(folder, target)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${path} isn't in the app's folder. Use a path such as public/images/picture.png.`)
  }
  return target
}

async function bytes(data) {
  if (typeof data === 'string') return Buffer.from(data, 'utf8')
  if (Buffer.isBuffer(data)) return data
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (typeof Blob !== 'undefined' && data instanceof Blob) return Buffer.from(await data.arrayBuffer())
  throw new TypeError('Save text, a Buffer, a Uint8Array, an ArrayBuffer or a Blob.')
}

function base64(data) {
  if (typeof data === 'string') return data.replace(/^data:[^;,]+;base64,/, '')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('base64')
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64')
  throw new TypeError('Give an image as base64 text, a Buffer, a Uint8Array or an ArrayBuffer.')
}

/** What a tool's run() gets beside its arguments. */
function context(signal) {
  const folder = process.cwd()
  return {
    /** The app's folder, where the tool runs. */
    folder,
    /** Aborted when the call is cancelled: pass it to fetch. */
    signal,
    /** The value of environment variable `name`, such as an API key. */
    env(name) {
      const value = process.env[name]
      if (!value) {
        throw new Error(
          `${name} isn't set. In Fabricator, open MCP servers, select Edit on this tool and add ${name}.`
        )
      }
      return value
    },
    /** Writes `data` to `path` in the app's folder, and returns the path as saved. */
    async save(path, data) {
      const target = inside(folder, path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, await bytes(data))
      return relative(folder, target).split(sep).join('/')
    },
    /** Reads the file at `path` in the app's folder. */
    async read(path) {
      return readFile(inside(folder, path))
    },
    /** Writes to Fabricator's log. */
    log(...args) {
      console.error(...args)
    },
    /** Text for chat, to return with an image. */
    text(text) {
      return { type: 'text', text: String(text), [CONTENT]: true }
    },
    /** An image for chat to see. */
    image(data, mimeType = 'image/png') {
      return { type: 'image', data: base64(data), mimeType, [CONTENT]: true }
    }
  }
}

/** A tool's result, as MCP returns it. */
function resultOf(value) {
  const text = (text) => ({ content: [{ type: 'text', text }] })
  if (value === undefined || value === null) return text('Done.')
  if (typeof value === 'string') return text(value)
  if (value[CONTENT]) return { content: [value] }
  if (Array.isArray(value) && value.length > 0 && value.every((item) => item?.[CONTENT])) {
    return { content: value }
  }
  if (Array.isArray(value.content)) return value
  return text(JSON.stringify(value, null, 2))
}

/**
 * Runs the server: `name` and `version` say what it is, and `tools` what it
 * offers. Each tool has a `name`, a `description` that tells chat what it does
 * and when to use it, its `input` (a JSON Schema of type "object"), whether
 * it's `readOnly` (it never changes anything), and `run(args, tool)`.
 */
export function serve({ name = 'tool', version = '1.0.0', tools } = {}) {
  const list = checked(tools)
  const byName = new Map(list.map((tool) => [tool.name, tool]))
  /** Calls in progress, by request id, to cancel. */
  const running = new Map()

  process.on('unhandledRejection', (error) => console.error(error))
  process.on('uncaughtException', (error) => console.error(error))

  const reply = (id, result) => send({ id, result })
  const fail = (id, code, message) => send({ id, error: { code, message } })

  async function call(id, params) {
    const tool = byName.get(params?.name)
    if (!tool) return fail(id, -32602, `Unknown tool: ${params?.name}`)
    const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {}
    const missing = (Array.isArray(tool.input.required) ? tool.input.required : []).filter(
      (key) => args[key] === undefined || args[key] === null || args[key] === ''
    )
    if (missing.length > 0) {
      return reply(id, { content: [{ type: 'text', text: `Give ${missing.join(', ')}.` }], isError: true })
    }
    const controller = new AbortController()
    running.set(id, controller)
    try {
      const value = await tool.run(args, context(controller.signal))
      if (!controller.signal.aborted) reply(id, resultOf(value))
    } catch (error) {
      console.error(error)
      if (!controller.signal.aborted) {
        reply(id, { content: [{ type: 'text', text: messageOf(error) }], isError: true })
      }
    } finally {
      running.delete(id)
    }
  }

  function handle(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return send({ id: null, error: { code: -32700, message: 'Parse error' } })
    }
    const { id, method, params } = message ?? {}
    if (typeof method !== 'string') return
    const request = id !== undefined && id !== null
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion
        return reply(id, {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : LATEST,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, version }
        })
      }
      case 'ping':
        return reply(id, {})
      case 'tools/list':
        return reply(id, {
          tools: list.map((tool) => ({
            name: tool.name,
            ...(typeof tool.title === 'string' ? { title: tool.title } : {}),
            description: tool.description,
            inputSchema: tool.input,
            annotations: { readOnlyHint: tool.readOnly === true }
          }))
        })
      case 'tools/call':
        return void call(id, params)
      case 'notifications/cancelled':
        return running.get(params?.requestId)?.abort()
      default:
        if (request) fail(id, -32601, `Method not found: ${method}`)
    }
  }

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  lines.on('line', (line) => {
    if (line.trim()) handle(line)
  })
  lines.on('close', () => process.exit(0))
}
