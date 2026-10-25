import type { CSSProperties, JSX } from 'react'
import type { TeamMap } from '@shared/ipc'
import { Codicon } from '../../icons'
import { ChangeLine, SourceIcon, resourceSummary, sourceApps, usedBy } from './DataNodes'
import { fabricWorkspaceUrl, hueOf } from './parts'
import {
  connectorAbility,
  connectorKind,
  connectorSignIn,
  dataIds,
  serviceKind,
  type ResourceItem,
  type ResourceView,
  type SourceItem
} from './resources'

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

function itemOf(view: ResourceView, id: string): ResourceItem | undefined {
  for (const app of Object.values(view.apps)) {
    const item = app.items.find((i) => i.id === id)
    if (item) return item
  }
  return undefined
}

function OpenInFabric({ workspaceId }: { workspaceId?: string }): JSX.Element | null {
  if (!workspaceId) return null
  return (
    <button type="button" className="btn btn--sm" onClick={() => void window.api.openExternal(fabricWorkspaceUrl(workspaceId))}>
      Open its workspace in Fabric <Codicon name="link-external" />
    </button>
  )
}

interface DetailsProps {
  map: TeamMap
  view: ResourceView
  /** A resource's or a source's node id. */
  selection: string
  opening: string | null
  onClose: () => void
  onSelect: (id: string) => void
  onOpenApp: (folder: string) => void
}

function ItemDetails({ map, view, item, opening, onSelect, onOpenApp }: Omit<DetailsProps, 'selection' | 'onClose'> & { item: ResourceItem }): JSX.Element {
  const app = map.apps.find((a) => a.folder === item.folder)
  const c = item.connector
  const kicker =
    item.kind === 'connector' ? `${connectorKind(c?.type ?? '').label} connector` : item.kind === 'database' ? 'Its own database' : item.title
  return (
    <>
      <header className="tmap-insp-head">
        <span className="tmap-icon-tile">
          <Codicon name={item.icon} />
        </span>
        <div className="tmap-titles">
          <span className="tmap-kicker">{app?.name ?? item.folder}</span>
          <h3>{item.title}</h3>
          <span className="tmap-dim">{item.kind === 'connector' ? kicker : resourceSummary(item)}</span>
        </div>
      </header>
      {!item.published && (
        <p className="tmap-insp-text">Not published yet: it&apos;s only in working copies so far.</p>
      )}

      {item.kind === 'database' && (
        <>
          <section className="tmap-insp-section">
            <h4>Tables</h4>
            {item.tables?.length ? (
              <ul className="tmap-insp-list">
                {item.tables.map((t) => (
                  <li key={t.name} className="tmap-insp-row">
                    <Codicon name="table" />
                    <span className="tmap-insp-grow">
                      {t.name}
                      <span className="tmap-dim tmap-block">{plural(t.fields, 'field')}</span>
                    </span>
                    <span className="tmap-chip" title="Who can read its rows">
                      {t.accessLabel}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="tmap-insp-text">No tables yet.</p>
            )}
          </section>
          <p className="tmap-insp-text">
            Part of the app. The published app and every preview each have their own copy, so trying a change never
            touches the published data.
          </p>
        </>
      )}

      {item.kind === 'files' && (
        <p className="tmap-insp-text">Keeps files people upload in the app, such as photos and documents.</p>
      )}

      {item.kind === 'functions' && (
        <>
          <section className="tmap-insp-section">
            <h4>Functions</h4>
            {item.functions?.length ? (
              <ul className="tmap-insp-list">
                {item.functions.map((name) => (
                  <li key={name} className="tmap-insp-row">
                    <Codicon name="symbol-method" />
                    <span className="tmap-insp-grow tmap-mono">{name}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="tmap-insp-text">No functions yet.</p>
            )}
          </section>
          {(item.audiences?.length ?? 0) > 0 && (
            <section className="tmap-insp-section">
              <h4>Reaches</h4>
              <ul className="tmap-insp-list">
                {item.audiences?.map((audience) => {
                  const id = dataIds.source(`service:${audience}`)
                  const source = view.sources.find((s) => s.id === id)
                  return (
                    <li key={audience}>
                      <button type="button" className="tmap-insp-row tmap-insp-row--button" onClick={() => onSelect(id)}>
                        {source ? <SourceIcon source={source} small /> : <Codicon name="cloud" />}
                        <span className="tmap-insp-grow">{serviceKind(audience).label}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          )}
          <p className="tmap-insp-text">
            Functions run in Fabric. They reach other services as the app itself, not as the person using it.
          </p>
        </>
      )}

      {item.kind === 'connector' && c && (
        <>
          <ul className="tmap-facts">
            {connectorAbility(c) && (
              <li>
                <span>Access</span>
                <span>{connectorAbility(c)}</span>
              </li>
            )}
            {connectorSignIn(c) && (
              <li>
                <span>Signs in as</span>
                <span>{connectorSignIn(c)}</span>
              </li>
            )}
            {c.database && (
              <li>
                <span>Database</span>
                <span>{c.database}</span>
              </li>
            )}
            {c.itemId && (
              <li>
                <span>Fabric item</span>
                <span className="tmap-mono tmap-ellipsis" title={c.itemId}>
                  {c.itemId}
                </span>
              </li>
            )}
          </ul>
          {item.links.map((link) => {
            const source = view.sources.find((s) => s.id === link.id)
            if (!source) return null
            return (
              <button
                key={link.id}
                type="button"
                className="tmap-insp-row tmap-insp-row--button tmap-insp-row--boxed"
                onClick={() => onSelect(source.id)}
              >
                <SourceIcon source={source} small />
                <span className="tmap-insp-grow">
                  {source.title}
                  <span className="tmap-dim tmap-block">{usedBy(sourceApps(map, view, source))}</span>
                </span>
                <Codicon name="chevron-right" />
              </button>
            )
          })}
        </>
      )}

      {item.changes.length > 0 && (
        <section className="tmap-insp-section">
          <h4>Being changed</h4>
          <ul className="tmap-insp-list">
            {item.changes.map((change, i) => (
              <li key={`${change.author}-${i}`} className="tmap-insp-row">
                <ChangeLine change={change} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="tmap-insp-actions">
        <button type="button" className="btn btn--sm btn--primary" disabled={opening !== null} onClick={() => onOpenApp(item.folder)}>
          {opening === item.folder ? 'Opening…' : `Open ${app?.name ?? 'the app'}`}
        </button>
        {c && <OpenInFabric workspaceId={c.workspaceId} />}
      </div>
    </>
  )
}

function SourceDetails({ map, view, source, onSelect }: Pick<DetailsProps, 'map' | 'view' | 'onSelect'> & { source: SourceItem }): JSX.Element {
  return (
    <>
      <header className="tmap-insp-head">
        <SourceIcon source={source} />
        <div className="tmap-titles">
          <span className="tmap-kicker">{source.kind === 'fabric' ? 'In Microsoft Fabric' : 'Service'}</span>
          <h3>{source.title}</h3>
          <span className="tmap-dim">{source.detail}</span>
        </div>
      </header>
      {!source.published && (
        <p className="tmap-insp-text">Not connected in a published app yet: only in working copies so far.</p>
      )}
      <section className="tmap-insp-section">
        <h4>Used by</h4>
        <ul className="tmap-insp-list">
          {source.users.map((id) => {
            const item = itemOf(view, id)
            const app = map.apps.find((a) => a.folder === item?.folder)
            if (!item || !app) return null
            return (
              <li key={id}>
                <button type="button" className="tmap-insp-row tmap-insp-row--button" onClick={() => onSelect(id)}>
                  <span className="tmap-mark tmap-mark--sm" style={{ '--hue': hueOf(app.folder) } as CSSProperties}>
                    {(app.name.trim()[0] ?? '?').toUpperCase()}
                  </span>
                  <span className="tmap-insp-grow">
                    {app.name}
                    <span className="tmap-dim tmap-block">
                      {item.title}
                      {item.published ? '' : ' · not published yet'}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </section>
      {source.kind === 'service' && (
        <p className="tmap-insp-text">
          Functions reach {source.title} as the app itself, so the app needs access to it there.
        </p>
      )}
      {source.workspaceId && (
        <div className="tmap-insp-actions">
          <OpenInFabric workspaceId={source.workspaceId} />
        </div>
      )}
    </>
  )
}

/** Details of the selected resource or source in the data view. */
export function ResourceDetails({ map, view, selection, opening, onClose, onSelect, onOpenApp }: DetailsProps): JSX.Element {
  const item = itemOf(view, selection)
  const source = item ? undefined : view.sources.find((s) => s.id === selection)
  return (
    <aside className="tmap-side tmap-inspector" aria-label="Details">
      <button type="button" className="tmap-icon-btn tmap-inspector-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
        <Codicon name="close" />
      </button>
      {item ? (
        <ItemDetails map={map} view={view} item={item} opening={opening} onSelect={onSelect} onOpenApp={onOpenApp} />
      ) : source ? (
        <SourceDetails map={map} view={view} source={source} onSelect={onSelect} />
      ) : (
        <p className="tmap-dim">This is no longer in the workspace.</p>
      )}
    </aside>
  )
}
