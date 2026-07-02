import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { StudioProject } from '@shared/ipc'
import {
  parseProjectDataModel,
  type AccessLevel,
  type DataModel,
  type ModelEntity,
  type ModelField
} from '../model/parseSchema'

interface Props {
  project: StudioProject
  /** Bumped by the parent when files may have changed (e.g. after a chat turn). */
  refreshKey: number
  /** Open a project file in the Code tab. */
  onOpenFile: (path: string) => void
  /** Hand a prompt to the Build chat (stage stages it in the composer). */
  onSendToChat: (display: string, prompt: string, stage?: boolean) => void
}

/** Short label + chip class for a field's semantic type. */
function typeChip(field: ModelField): { label: string; cls: string } {
  switch (field.type) {
    case 'uuid':
      return { label: 'uuid', cls: 'model-chip--id' }
    case 'text':
      return { label: 'text', cls: 'model-chip--text' }
    case 'email':
      return { label: 'email', cls: 'model-chip--text' }
    case 'int':
      return { label: 'int', cls: 'model-chip--num' }
    case 'decimal':
      return { label: 'decimal', cls: 'model-chip--num' }
    case 'boolean':
      return { label: 'bool', cls: 'model-chip--bool' }
    case 'date':
      return { label: 'date', cls: 'model-chip--date' }
    case 'blob':
      return { label: 'blob', cls: 'model-chip--blob' }
    case 'enum':
      return { label: 'enum', cls: 'model-chip--enum' }
    case 'relation':
      return { label: field.relationKind === 'many' ? '↦ many' : '↦ one', cls: 'model-chip--rel' }
    default:
      return { label: field.tsType ?? '—', cls: 'model-chip--unknown' }
  }
}

const ACCESS_META: Record<AccessLevel, { dot: string; tone: string }> = {
  public: { dot: '●', tone: 'danger' },
  authenticated: { dot: '●', tone: 'warn' },
  default: { dot: '●', tone: 'warn' },
  mixed: { dot: '●', tone: 'warn' },
  scoped: { dot: '●', tone: 'ok' }
}

/** Whether an entity's access is loose enough to warrant a "Harden" action. */
function needsHardening(level: AccessLevel): boolean {
  return level === 'public' || level === 'authenticated' || level === 'default' || level === 'mixed'
}

interface Edge {
  id: string
  d: string
  kind: 'one' | 'many' | 'fk'
}

/** Where the line from a rect's centre toward (tx,ty) crosses the rect border. */
function borderPoint(
  rect: { left: number; top: number; width: number; height: number },
  tx: number,
  ty: number
): { x: number; y: number } {
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  const dx = tx - cx
  const dy = ty - cy
  if (dx === 0 && dy === 0) return { x: cx, y: cy }
  const hw = rect.width / 2
  const hh = rect.height / 2
  const scale = 1 / Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh)
  return { x: cx + dx * scale, y: cy + dy * scale }
}

export default function ModelView({
  project,
  refreshKey,
  onOpenFile,
  onSendToChat
}: Props): JSX.Element {
  const [model, setModel] = useState<DataModel | null>(null)
  const [loading, setLoading] = useState(true)
  const [highlight, setHighlight] = useState<string | null>(null)

  const gridRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef(new Map<string, HTMLDivElement>())
  const [edges, setEdges] = useState<Edge[]>([])
  const [canvas, setCanvas] = useState({ w: 0, h: 0 })

  // (Re)parse the data model whenever the project or its files change.
  useEffect(() => {
    let alive = true
    setLoading(true)
    parseProjectDataModel(project.id)
      .then((m) => {
        if (alive) {
          setModel(m)
          setLoading(false)
        }
      })
      .catch(() => {
        if (alive) {
          setModel({ entities: [], relations: [], warnings: [], hasSchema: false })
          setLoading(false)
        }
      })
    return () => {
      alive = false
    }
  }, [project.id, refreshKey])

  const entityNames = useMemo(
    () => new Set(model?.entities.map((e) => e.name) ?? []),
    [model]
  )

  // Compute the SVG relation edges from the laid-out card positions.
  const recomputeEdges = useCallback(() => {
    const grid = gridRef.current
    if (!grid || !model) return
    setCanvas({ w: grid.scrollWidth, h: grid.scrollHeight })
    const rectOf = (name: string): { left: number; top: number; width: number; height: number } | null => {
      const el = cardRefs.current.get(name)
      if (!el) return null
      return { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight }
    }
    const next: Edge[] = []
    let seq = 0
    for (const rel of model.relations) {
      if (rel.from === rel.to) continue // self-relations aren't drawn as edges
      const a = rectOf(rel.from)
      const b = rectOf(rel.to)
      if (!a || !b) continue
      const ac = { x: a.left + a.width / 2, y: a.top + a.height / 2 }
      const bc = { x: b.left + b.width / 2, y: b.top + b.height / 2 }
      const p1 = borderPoint(a, bc.x, bc.y)
      const p2 = borderPoint(b, ac.x, ac.y)
      const dx = p2.x - p1.x
      const c1x = p1.x + dx * 0.45
      const c2x = p2.x - dx * 0.45
      const d = `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} C ${c1x.toFixed(1)} ${p1.y.toFixed(1)}, ${c2x.toFixed(1)} ${p2.y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`
      next.push({ id: `${rel.from}.${rel.via}->${rel.to}#${seq++}`, d, kind: rel.kind })
    }
    setEdges(next)
  }, [model])

  useLayoutEffect(() => {
    recomputeEdges()
  }, [recomputeEdges])

  // Recompute edges when the grid resizes (cards reflow / window resize).
  useEffect(() => {
    const grid = gridRef.current
    if (!grid || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => recomputeEdges())
    ro.observe(grid)
    return () => ro.disconnect()
  }, [recomputeEdges])

  const setCardRef = useCallback(
    (name: string) =>
      (el: HTMLDivElement | null): void => {
        if (el) cardRefs.current.set(name, el)
        else cardRefs.current.delete(name)
      },
    []
  )

  const explainEntity = useCallback(
    (entity: ModelEntity): void => {
      const prompt =
        `Explain the \`${entity.name}\` entity in this Rayfin app (defined in ${entity.file}). ` +
        'Walk through its fields, its relationships to other entities, and what its current ' +
        `access control ("${entity.access.label}" — ${entity.access.detail}) means for who can ` +
        'read and write its rows. Do not change any code — just explain.'
      onSendToChat(`Explain ${entity.name}`, prompt)
    },
    [onSendToChat]
  )

  const hardenEntity = useCallback(
    (entity: ModelEntity): void => {
      const prompt =
        `In this Rayfin app, the \`${entity.name}\` entity (${entity.file}) currently has access ` +
        `"${entity.access.label}": ${entity.access.detail}\n\n` +
        'Please tighten its access control following Rayfin conventions: add an appropriate ' +
        '`@role`/`@authenticated` decorator with a row-level `policy` that scopes rows to their ' +
        'owner (typically by matching a `*_id` field against `claims.sub`), or keep `@anonymous` ' +
        'only if the data is genuinely public. Explain the change you make. Keep the app building ' +
        'and do not run `rayfin up` or deploy — Fabricator redeploys automatically.'
      onSendToChat(`Harden access on ${entity.name}`, prompt)
    },
    [onSendToChat]
  )

  const addModel = useCallback((): void => {
    onSendToChat(
      'Add a data model',
      'This Rayfin app has no data model yet. Please add one or more entities under ' +
        '`rayfin/data/` using the `@microsoft/rayfin-core` decorators (`@entity`, field ' +
        'decorators like `@uuid`/`@text`/`@boolean`/`@date`, and `@role`/`@authenticated` with ' +
        'a row-level `policy` for access control), and register them in `rayfin/data/schema.ts`. ',
      true
    )
  }, [onSendToChat])

  if (loading && !model) {
    return (
      <div className="model-view">
        <div className="model-empty">Reading your data model…</div>
      </div>
    )
  }

  if (!model?.hasSchema) {
    return (
      <div className="model-view">
        <div className="model-empty model-empty--cta">
          <div className="model-empty-title">No data model yet</div>
          <p className="model-empty-sub">
            Rayfin entities live under <code>rayfin/data/</code> and are listed in{' '}
            <code>schema.ts</code>. Once you add some, this tab draws them as an entity‑relationship
            diagram with per‑entity access badges.
          </p>
          <button className="btn btn--primary" onClick={addModel}>
            Add a data model with Copilot
          </button>
        </div>
      </div>
    )
  }

  if (model.entities.length === 0) {
    return (
      <div className="model-view">
        <div className="model-empty model-empty--cta">
          <div className="model-empty-title">Your schema has no entities</div>
          <p className="model-empty-sub">
            <code>rayfin/data/schema.ts</code> exists but its <code>schema</code> array is empty.
          </p>
          <button className="btn btn--primary" onClick={addModel}>
            Add an entity with Copilot
          </button>
        </div>
      </div>
    )
  }

  const entityCount = model.entities.length
  const relCount = model.relations.length

  return (
    <div className="model-view">
      <div className="model-head">
        <div className="model-head-titles">
          <h2 className="model-title">Data model</h2>
          <span className="model-subtitle">
            {entityCount} {entityCount === 1 ? 'entity' : 'entities'}
            {relCount > 0 && ` · ${relCount} ${relCount === 1 ? 'relationship' : 'relationships'}`}
          </span>
        </div>
        <div className="model-legend" aria-hidden="true">
          <span className="model-legend-item">
            <span className="model-badge-dot model-badge-dot--ok">●</span> Row‑scoped
          </span>
          <span className="model-legend-item">
            <span className="model-badge-dot model-badge-dot--warn">●</span> Any signed‑in
          </span>
          <span className="model-legend-item">
            <span className="model-badge-dot model-badge-dot--danger">●</span> Public
          </span>
        </div>
      </div>

      <div className="model-canvas">
        <div className="model-grid" ref={gridRef}>
          <svg
            className="model-edges"
            width={canvas.w}
            height={canvas.h}
            viewBox={`0 0 ${canvas.w} ${canvas.h}`}
            aria-hidden="true"
          >
            <defs>
              <marker
                id="model-arrow"
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M0 0 L8 4 L0 8 z" className="model-arrow-head" />
              </marker>
            </defs>
            {edges.map((e) => (
              <path
                key={e.id}
                d={e.d}
                className={`model-edge model-edge--${e.kind === 'fk' ? 'fk' : 'rel'}`}
                markerEnd="url(#model-arrow)"
                fill="none"
              />
            ))}
          </svg>

          {model.entities.map((entity) => {
            const tone = ACCESS_META[entity.access.level].tone
            const dim = highlight !== null && highlight !== entity.name
            return (
              <div
                key={entity.name}
                ref={setCardRef(entity.name)}
                className={`model-card model-card--${tone}${dim ? ' model-card--dim' : ''}`}
                onMouseEnter={() => setHighlight(entity.name)}
                onMouseLeave={() => setHighlight(null)}
              >
                <div className="model-card-head">
                  <button
                    className="model-card-name"
                    title={`Open ${entity.file}`}
                    onClick={() => onOpenFile(entity.file)}
                  >
                    {entity.name}
                    {entity.customName && entity.customName !== entity.name && (
                      <span className="model-card-alias">“{entity.customName}”</span>
                    )}
                  </button>
                  <button
                    className={`model-badge model-badge--${tone}`}
                    title={entity.access.detail}
                    onClick={() => explainEntity(entity)}
                  >
                    {entity.access.label}
                  </button>
                </div>

                <ul className="model-fields">
                  {entity.fields.map((field) => {
                    const chip = typeChip(field)
                    return (
                      <li key={field.name} className="model-field">
                        <span className="model-field-name">
                          {field.primaryKey && (
                            <span className="model-field-key" title="Primary key">
                              ⚷
                            </span>
                          )}
                          {field.name}
                          {field.optional && <span className="model-field-opt">?</span>}
                        </span>
                        <span className="model-field-meta">
                          {field.unique && <span className="model-mark" title="Unique">unique</span>}
                          {field.fkTo && (
                            <button
                              className="model-fk"
                              title={`References ${field.fkTo}`}
                              onClick={() => setHighlight(field.fkTo ?? null)}
                            >
                              → {field.fkTo}
                            </button>
                          )}
                          {field.relationTo && entityNames.has(field.relationTo) && (
                            <button
                              className="model-fk"
                              title={`Relates to ${field.relationTo}`}
                              onClick={() => setHighlight(field.relationTo ?? null)}
                            >
                              ↦ {field.relationTo}
                            </button>
                          )}
                          <span className={`model-chip ${chip.cls}`}>{chip.label}</span>
                        </span>
                      </li>
                    )
                  })}
                  {entity.fields.length === 0 && (
                    <li className="model-field model-field--empty">No fields parsed.</li>
                  )}
                </ul>

                <div className="model-card-actions">
                  <button className="btn btn--xs btn--ghost" onClick={() => onOpenFile(entity.file)}>
                    Open file
                  </button>
                  <button className="btn btn--xs btn--ghost" onClick={() => explainEntity(entity)}>
                    Explain
                  </button>
                  {needsHardening(entity.access.level) && (
                    <button className="btn btn--xs btn--ghost" onClick={() => hardenEntity(entity)}>
                      Harden
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {model.warnings.length > 0 && (
        <div className="model-warnings">
          {model.warnings.map((w, i) => (
            <div key={i} className="model-warning">
              {w}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
