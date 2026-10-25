import type { TeamMap } from '@shared/ipc'
import { Codicon } from '../../icons'
import { Avatar, FabricGlyph } from './parts'
import {
  connectorAbility,
  copyName,
  serviceKind,
  type ResourceChange,
  type ResourceItem,
  type ResourceView,
  type SourceItem
} from './resources'

import type { JSX } from 'react'

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** "Your copy adds Receipt", with the author's face. */
export function ChangeLine({ change }: { change: ResourceChange }): JSX.Element {
  const text = `${copyName(change)} ${change.what}`
  return (
    <span className={`tmap-change tmap-change--${change.kind}`} title={text}>
      <Avatar login={change.author || 'you'} url={change.avatarUrl} size={16} />
      <span className="tmap-change-text">{text}</span>
    </span>
  )
}

/** A source's glyph: Fabric's own for Fabric, else its type's icon. */
export function SourceIcon({ source, small }: { source: SourceItem; small?: boolean }): JSX.Element {
  if (source.audience === 'Fabric') return <FabricGlyph />
  return (
    <span className={`tmap-icon-tile${small ? ' tmap-icon-tile--sm' : ''}`}>
      <Codicon name={source.icon} />
    </span>
  )
}

/** One line under a resource's name: what it holds or does. */
export function resourceSummary(item: ResourceItem): string {
  switch (item.kind) {
    case 'database':
      return item.relations ? `${item.detail} · ${plural(item.relations, 'relationship')}` : item.detail
    case 'functions': {
      const reach = item.audiences ?? []
      if (!reach.length) return item.detail
      return `${item.detail} · reaches ${reach.length === 1 ? serviceKind(reach[0]).label : `${reach.length} services`}`
    }
    case 'connector': {
      const ability = item.connector ? connectorAbility(item.connector) : ''
      return ability ? `${item.detail} · ${ability}` : item.detail
    }
    default:
      return item.detail
  }
}

/** The apps that use a source, by name. */
export function sourceApps(map: TeamMap, view: ResourceView, source: SourceItem): string[] {
  const folders = new Set(
    source.users.flatMap((id) =>
      Object.entries(view.apps).flatMap(([folder, app]) => (app.items.some((i) => i.id === id) ? [folder] : []))
    )
  )
  return map.apps.filter((a) => folders.has(a.folder)).map((a) => a.name)
}

export function usedBy(names: string[]): string {
  if (!names.length) return ''
  return names.length <= 2 ? `Used by ${names.join(' and ')}` : `Used by ${names.length} apps`
}

export function ResourceNodeBody({ item }: { item: ResourceItem }): JSX.Element {
  return (
    <>
      <div className="tmap-node-head">
        <span className="tmap-icon-tile">
          <Codicon name={item.icon} />
        </span>
        <div className="tmap-titles">
          <strong className="tmap-ellipsis">{item.title}</strong>
          <span className="tmap-dim tmap-ellipsis">{resourceSummary(item)}</span>
        </div>
      </div>
      {item.changes.length > 0 && (
        <div className="tmap-changes">
          {item.changes.slice(0, 2).map((change, i) => (
            <ChangeLine key={`${change.author}-${i}`} change={change} />
          ))}
          {item.changes.length > 2 && <span className="tmap-dim">and {item.changes.length - 2} more</span>}
        </div>
      )}
    </>
  )
}

export function SourceNodeBody({ source, apps }: { source: SourceItem; apps: string[] }): JSX.Element {
  return (
    <>
      <div className="tmap-node-head">
        <SourceIcon source={source} />
        <div className="tmap-titles">
          <strong className="tmap-ellipsis">{source.title}</strong>
          <span className="tmap-dim tmap-ellipsis">{source.detail}</span>
        </div>
      </div>
      <div className="tmap-node-foot">
        <span className="tmap-dim tmap-ellipsis">{usedBy(apps)}</span>
      </div>
    </>
  )
}

/** An app with nothing in the data view: still reading, unreadable, or simply none. */
export function EmptyNodeBody({ loading, error }: { loading: boolean; error?: string }): JSX.Element {
  return (
    <span className="tmap-dim tmap-ellipsis" title={error}>
      {loading ? (
        <>
          <span className="tmap-spinner" /> Reading the app…
        </>
      ) : (
        (error ?? 'No database or connections')
      )}
    </span>
  )
}
