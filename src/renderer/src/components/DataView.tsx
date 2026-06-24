import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DataApiConfig, StudioProject } from '@shared/ipc'
import { parseProjectDataModel, type DataModel, type ModelField } from '../model/parseSchema'

interface Props {
  project: StudioProject
  /** Bumped by the parent when files may have changed (e.g. after a chat turn). */
  refreshKey: number
  /** Hand a prompt to the Build chat (stage stages it in the composer). */
  onSendToChat: (display: string, prompt: string, stage?: boolean) => void
}

/** A queryable collection: a GraphQL root field returning a `*Connection` with `items`. */
interface Collection {
  /** Root query field name (e.g. `todos`). */
  queryField: string
  /** Item object type name (e.g. `Todo`). */
  itemType: string
  /** Scalar/enum fields to select by default. */
  scalarFields: string[]
  /** Whether the root field accepts a `first:` argument. */
  hasFirst: boolean
  /** Whether the connection exposes `hasNextPage`. */
  hasNext: boolean
  /** Whether the connection exposes `endCursor`. */
  hasCursor: boolean
}

// ── GraphQL introspection types (trimmed to what we read) ──────────────────────
interface TypeRef {
  kind: string
  name: string | null
  ofType?: TypeRef | null
}
interface IntrospField {
  name: string
  args?: { name: string }[] | null
  type: TypeRef
}
interface IntrospType {
  kind: string
  name: string | null
  fields?: IntrospField[] | null
}
interface IntrospSchema {
  queryType?: { name: string } | null
  types: IntrospType[]
}

/** Follow `ofType` to the underlying named type ref. */
function unwrap(ref: TypeRef): TypeRef {
  let cur: TypeRef = ref
  while (cur.ofType) cur = cur.ofType
  return cur
}

/** Build the list of queryable collections from a GraphQL introspection result. */
function collectionsFromIntrospection(schema: IntrospSchema): Collection[] {
  const byName = new Map<string, IntrospType>()
  for (const t of schema.types) if (t.name) byName.set(t.name, t)

  const queryTypeName = schema.queryType?.name ?? 'Query'
  const queryType = byName.get(queryTypeName)
  if (!queryType?.fields) return []

  const out: Collection[] = []
  for (const field of queryType.fields) {
    const named = unwrap(field.type)
    if (!named.name) continue
    const connType = byName.get(named.name)
    const itemsField = connType?.fields?.find((f) => f.name === 'items')
    if (!connType?.fields || !itemsField) continue // not a connection

    const itemNamed = unwrap(itemsField.type)
    const itemType = itemNamed.name ? byName.get(itemNamed.name) : undefined
    const scalarFields = (itemType?.fields ?? [])
      .filter((f) => {
        const u = byName.get(unwrap(f.type).name ?? '')
        return u?.kind === 'SCALAR' || u?.kind === 'ENUM'
      })
      .map((f) => f.name)
    if (scalarFields.length === 0) continue

    out.push({
      queryField: field.name,
      itemType: itemNamed.name ?? named.name,
      scalarFields,
      hasFirst: Boolean(field.args?.some((a) => a.name === 'first')),
      hasNext: connType.fields.some((f) => f.name === 'hasNextPage'),
      hasCursor: connType.fields.some((f) => f.name === 'endCursor')
    })
  }
  return out.sort((a, b) => a.queryField.localeCompare(b.queryField))
}

/** Minimal English pluralizer for the offline (no-introspection) fallback. */
function pluralize(word: string): string {
  if (/[^aeiou]y$/i.test(word)) return word.replace(/y$/i, 'ies')
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`
  return `${word}s`
}

const lowerFirst = (s: string): string => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s)

/** Build fallback collections from the statically-parsed schema. */
function collectionsFromModel(model: DataModel): Collection[] {
  const isScalar = (f: ModelField): boolean => f.type !== 'relation'
  return model.entities
    .map((e) => ({
      queryField: lowerFirst(pluralize(e.customName ?? e.name)),
      itemType: e.customName ?? e.name,
      scalarFields: e.fields.filter(isScalar).map((f) => f.name),
      hasFirst: true,
      hasNext: true,
      hasCursor: true
    }))
    .filter((c) => c.scalarFields.length > 0)
}

/** Compose a "list rows" GraphQL query for a collection. */
function listQuery(c: Collection, limit = 25): string {
  const args = c.hasFirst ? `(first: ${limit})` : ''
  const fields = c.scalarFields.map((f) => `      ${f}`).join('\n')
  const tail = [c.hasNext ? '    hasNextPage' : '', c.hasCursor ? '    endCursor' : '']
    .filter(Boolean)
    .join('\n')
  return `query {\n  ${c.queryField}${args} {\n    items {\n${fields}\n    }${tail ? `\n${tail}` : ''}\n  }\n}\n`
}

/** A GraphQL response envelope. */
interface GqlResponse {
  data?: Record<string, unknown> | null
  errors?: { message?: string }[] | null
}

/** Find the first `{ items: [...] }` array anywhere in a GraphQL `data` payload. */
function findRows(data: unknown): Record<string, unknown>[] | null {
  if (!data || typeof data !== 'object') return null
  const obj = data as Record<string, unknown>
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') {
      const items = (value as Record<string, unknown>).items
      if (Array.isArray(items)) return items as Record<string, unknown>[]
      if (Array.isArray(value)) return value as Record<string, unknown>[]
    }
  }
  return null
}

/** Stringify a cell value compactly for the table view. */
function cell(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export default function DataView({ project, refreshKey, onSendToChat }: Props): JSX.Element {
  const [config, setConfig] = useState<DataApiConfig | null>(null)
  const [loadingConfig, setLoadingConfig] = useState(true)
  const [collections, setCollections] = useState<Collection[]>([])
  const [introspectNote, setIntrospectNote] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  const [query, setQuery] = useState('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<GqlResponse | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [view, setView] = useState<'table' | 'json'>('table')

  // Discover the data API + schema whenever the project or its files change.
  useEffect(() => {
    let cancelled = false
    setLoadingConfig(true)
    setIntrospectNote(null)
    ;(async () => {
      const cfg = (await window.api.data.config(project.id).catch(() => null)) as DataApiConfig | null
      if (cancelled) return
      setConfig(cfg)
      if (!cfg?.configured) {
        setCollections([])
        setLoadingConfig(false)
        return
      }
      // Prefer live introspection (exact query field names); fall back to the
      // statically-parsed schema if introspection is unavailable.
      let cols: Collection[] = []
      try {
        const res = (await window.api.data.introspect(project.id)) as GqlResponse
        const schema = (res?.data as { __schema?: IntrospSchema } | undefined)?.__schema
        if (schema) cols = collectionsFromIntrospection(schema)
        if (!schema || cols.length === 0) {
          const msg = res?.errors?.[0]?.message
          setIntrospectNote(
            msg
              ? `Live schema introspection was rejected (${msg}). Showing entities from your source — generated queries may need tweaks.`
              : 'Live schema introspection returned nothing. Showing entities from your source.'
          )
        }
      } catch (e) {
        setIntrospectNote(
          `Couldn't reach the data API for introspection (${String(e)}). Showing entities from your source.`
        )
      }
      if (cols.length === 0) {
        const model = await parseProjectDataModel(project.id).catch(() => null)
        if (model) cols = collectionsFromModel(model)
      }
      if (cancelled) return
      setCollections(cols)
      setLoadingConfig(false)
    })()
    return () => {
      cancelled = true
    }
  }, [project.id, refreshKey])

  const runQuery = useCallback(
    async (q: string) => {
      const text = q.trim()
      if (!text) return
      setRunning(true)
      setRunError(null)
      try {
        const res = (await window.api.data.query(project.id, text)) as GqlResponse
        setResult(res)
        if (res?.errors?.length) {
          setRunError(res.errors.map((e) => e.message ?? 'Unknown error').join('\n'))
        }
        // Default to the table view when the payload looks tabular.
        if (res?.data && findRows(res.data)) setView('table')
        else setView('json')
      } catch (e) {
        setResult(null)
        setRunError(String(e))
      } finally {
        setRunning(false)
      }
    },
    [project.id]
  )

  const selectCollection = useCallback(
    (c: Collection) => {
      setSelected(c.queryField)
      const q = listQuery(c)
      setQuery(q)
      void runQuery(q)
    },
    [runQuery]
  )

  const rows = useMemo(() => (result?.data ? findRows(result.data) : null), [result])
  const columns = useMemo(() => {
    if (!rows) return []
    const set = new Set<string>()
    for (const r of rows.slice(0, 200)) for (const k of Object.keys(r)) set.add(k)
    return [...set]
  }, [rows])

  // ── Empty / loading states ───────────────────────────────────────────────
  if (loadingConfig) {
    return (
      <div className="data-view data-view--empty">
        <div className="data-empty">
          <div className="data-spinner" />
          <p>Connecting to your app's data API…</p>
        </div>
      </div>
    )
  }

  if (!config?.configured) {
    return (
      <div className="data-view data-view--empty">
        <div className="data-empty">
          <div className="data-empty-mark">⛁</div>
          <h3>No live data yet</h3>
          <p>
            Deploy this app to Fabric (the <strong>Deploy</strong> button in the header), then come
            back here to browse and query its managed data API.
          </p>
          {config?.apiUrl && !config.hasKey && (
            <p className="data-hint">
              An endpoint was found, but no publishable key. Run <code>npx rayfin env</code> in the
              project, or redeploy, to refresh <code>rayfin/.env</code>.
            </p>
          )}
        </div>
      </div>
    )
  }

  const apiHost = (() => {
    try {
      return config.endpoint ? new URL(config.endpoint).host : ''
    } catch {
      return ''
    }
  })()

  return (
    <div className="data-view">
      <aside className="data-sidebar">
        <div className="data-sidebar-head">
          <span className="data-sidebar-title">Collections</span>
          <span className="data-sidebar-count">{collections.length}</span>
        </div>
        <div className="data-coll-list">
          {collections.length === 0 && <p className="data-muted">No entities found in this app.</p>}
          {collections.map((c) => (
            <button
              key={c.queryField}
              className={`data-coll${selected === c.queryField ? ' data-coll--active' : ''}`}
              onClick={() => selectCollection(c)}
              title={`List rows from ${c.itemType}`}
            >
              <span className="data-coll-name">{c.queryField}</span>
              <span className="data-coll-meta">{c.scalarFields.length} fields</span>
            </button>
          ))}
        </div>
        <div className="data-conn">
          <span className="data-conn-dot" title={`Source: ${config.source ?? 'env'}`} />
          <span className="data-conn-host" title={config.endpoint}>
            {apiHost}
          </span>
        </div>
      </aside>

      <section className="data-main">
        {introspectNote && (
          <div className="data-note" role="status">
            {introspectNote}
          </div>
        )}

        <div className="data-toolbar">
          <span className="data-toolbar-label">GraphQL query</span>
          <div className="data-toolbar-actions">
            <button
              className="btn btn--xs btn--ghost"
              disabled={!query.trim()}
              onClick={() =>
                onSendToChat(
                  'Explain this data query',
                  `Explain what this GraphQL query against my Rayfin data API does, and suggest improvements (filtering, ordering, pagination, selecting fewer fields):\n\n\`\`\`graphql\n${query.trim()}\n\`\`\``,
                  true
                )
              }
            >
              Explain
            </button>
            <button
              className="btn btn--xs btn--primary"
              disabled={running || !query.trim()}
              onClick={() => void runQuery(query)}
            >
              {running ? 'Running…' : 'Run ▷'}
            </button>
          </div>
        </div>

        <textarea
          className="data-editor"
          spellCheck={false}
          value={query}
          placeholder={'query {\n  todos(first: 25) {\n    items { id title }\n  }\n}'}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault()
              void runQuery(query)
            }
          }}
        />

        <div className="data-results">
          <div className="data-results-head">
            <span className="data-results-title">
              {rows ? `${rows.length} row${rows.length === 1 ? '' : 's'}` : 'Result'}
            </span>
            <div className="seg seg--toolbar">
              <button
                className={`seg-btn${view === 'table' ? ' seg-btn--active' : ''}`}
                disabled={!rows}
                onClick={() => setView('table')}
              >
                Table
              </button>
              <button
                className={`seg-btn${view === 'json' ? ' seg-btn--active' : ''}`}
                onClick={() => setView('json')}
              >
                JSON
              </button>
            </div>
          </div>

          {runError && <pre className="data-error">{runError}</pre>}

          {!runError && !result && (
            <p className="data-muted data-results-empty">
              Pick a collection or write a query, then press <kbd>Run</kbd> (or{' '}
              <kbd>Ctrl/⌘ + Enter</kbd>).
            </p>
          )}

          {result && view === 'table' && rows && (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    {columns.map((col) => (
                      <th key={col}>{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 200).map((r, i) => (
                    <tr key={i}>
                      {columns.map((col) => (
                        <td key={col} title={cell(r[col])}>
                          {cell(r[col])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length > 200 && (
                <p className="data-muted">Showing the first 200 of {rows.length} rows.</p>
              )}
            </div>
          )}

          {result && (view === 'json' || !rows) && (
            <pre className="data-json">{JSON.stringify(result.data ?? result, null, 2)}</pre>
          )}
        </div>
      </section>
    </div>
  )
}
