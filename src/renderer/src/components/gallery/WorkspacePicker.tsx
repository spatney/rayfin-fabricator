import { useState, type CSSProperties, type JSX } from 'react'
import { Codicon } from '../icons'
import { hueOf } from '../team/map/parts'
import { GalleryMenu } from './GalleryMenu'
import { ago, count, splitWorkspaceName, workspaceTitle, type GalleryWorkspace } from './model'

/** Recent workspaces listed before the others. */
const RECENT_SHOWN = 5

/** A workspace's name, its generated tail (a GUID, a timestamp) quieter, so the name reads first. */
export function WorkspaceName({ name }: { name: string }): JSX.Element {
  const [base, tail] = splitWorkspaceName(name)
  return (
    <>
      {base}
      {tail && <span className="gallery-ws-tail">{tail}</span>}
    </>
  )
}

export function workspaceIcon(name: string): string {
  return name === 'My workspace' ? 'account' : 'folder'
}

/** Four tiles: every workspace. */
function AllIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2" y="2" width="5" height="5" rx="1.5" />
      <rect x="9" y="2" width="5" height="5" rx="1.5" />
      <rect x="2" y="9" width="5" height="5" rx="1.5" />
      <rect x="9" y="9" width="5" height="5" rx="1.5" />
    </svg>
  )
}

/** "Just now", "8 hours ago": when you last used a workspace. */
function usedWhen(at: number | undefined): string | undefined {
  const words = at ? ago(new Date(at).toISOString()) : undefined
  return words ? words[0].toUpperCase() + words.slice(1) : undefined
}

function byName(a: GalleryWorkspace, b: GalleryWorkspace): number {
  return a.name.localeCompare(b.name, 'en', { sensitivity: 'base', numeric: true })
}

function WorkspaceRow({
  workspace: w,
  recent,
  selected,
  onPick
}: {
  workspace: GalleryWorkspace
  /** One your apps here use: its initial on its color, and when you last used it. */
  recent: boolean
  selected: boolean
  onPick: (id: string) => void
}): JSX.Element {
  const { title, detail } = workspaceTitle(w.name)
  const sub = (recent && usedWhen(w.usedAt)) || detail
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      className={`gallery-ws-row${selected ? ' is-selected' : ''}`}
      title={w.name}
      onClick={() => onPick(w.id)}
    >
      {recent ? (
        <span
          className="gallery-ws-tile gallery-ws-tile--hue"
          style={{ '--hue': hueOf(w.name) } as CSSProperties}
          aria-hidden="true"
        >
          {[...title][0]?.toUpperCase()}
        </span>
      ) : (
        <span className="gallery-ws-tile" aria-hidden="true">
          <Codicon name={workspaceIcon(w.name)} />
        </span>
      )}
      <span className="gallery-ws-text">
        <span className="gallery-ws-name">{title}</span>
        {sub && <span className="gallery-ws-sub">{sub}</span>}
      </span>
      <span className="gallery-ws-apps">{count(w.count, 'app')}</span>
      {selected && <Codicon name="check" className="gallery-ws-check" />}
    </button>
  )
}

function WorkspaceList({
  recent,
  others,
  total,
  value,
  onPick
}: {
  recent: readonly GalleryWorkspace[]
  others: readonly GalleryWorkspace[]
  total: number
  value: string | null
  onPick: (id: string | null) => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const matches = (w: GalleryWorkspace): boolean =>
    !q || w.name.toLowerCase().includes(q) || workspaceTitle(w.name).title.toLowerCase().includes(q)
  // Recent ones past the first few join the others, A to Z.
  const overflow = recent.slice(RECENT_SHOWN)
  const rest = overflow.length > 0 ? [...overflow, ...others].sort(byName) : others
  const recentShown = recent.slice(0, RECENT_SHOWN).filter(matches)
  const restShown = rest.filter(matches)
  const all = recent.length + others.length
  const found = recentShown.length + restShown.length

  const row = (w: GalleryWorkspace, isRecent: boolean): JSX.Element => (
    <WorkspaceRow
      key={w.id}
      workspace={w}
      recent={isRecent}
      selected={w.id === value}
      onPick={onPick}
    />
  )

  return (
    <>
      <div className="gallery-ws-head">
        <span className="gallery-ws-title">Workspaces</span>
        <span className="gallery-ws-badge">{all.toLocaleString('en')}</span>
      </div>
      <label className="gallery-ws-search">
        <Codicon name="search" />
        <input
          type="text"
          placeholder="Search workspaces…"
          aria-label="Search workspaces"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="gallery-ws-list">
        {!q && (
          <>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={value === null}
              className={`gallery-ws-row${value === null ? ' is-selected' : ''}`}
              onClick={() => onPick(null)}
            >
              <span className="gallery-ws-tile gallery-ws-tile--all" aria-hidden="true">
                <AllIcon />
              </span>
              <span className="gallery-ws-text">
                <span className="gallery-ws-name">All workspaces</span>
              </span>
              <span className="gallery-ws-apps">{count(total, 'app')}</span>
              {value === null && <Codicon name="check" className="gallery-ws-check" />}
            </button>
            {found > 0 && <div className="gallery-ws-sep" role="separator" />}
          </>
        )}
        {recentShown.length > 0 && (
          <div role="group" aria-label="Recent">
            <div className="gallery-ws-heading" aria-hidden="true">
              Recent
            </div>
            {recentShown.map((w) => row(w, true))}
          </div>
        )}
        {recentShown.length > 0 && restShown.length > 0 && (
          <div className="gallery-ws-sep" role="separator" />
        )}
        {restShown.length > 0 && (
          <div role="group" aria-label={recentShown.length > 0 ? 'Other workspaces' : 'Workspaces'}>
            {recentShown.length > 0 && (
              <div className="gallery-ws-heading" aria-hidden="true">
                Other workspaces
              </div>
            )}
            {restShown.map((w) => row(w, false))}
          </div>
        )}
        {q && found === 0 && (
          <div className="gallery-ws-empty">No workspace matches “{query.trim()}”.</div>
        )}
      </div>
      <div className="gallery-ws-foot">
        <span>
          {q
            ? `${found.toLocaleString('en')} of ${count(all, 'workspace')}`
            : count(all, 'workspace')}
        </span>
        <span className="gallery-ws-keys" aria-hidden="true">
          <kbd>↑</kbd>
          <kbd>↓</kbd>
          <span>Navigate</span>
          <span className="gallery-ws-keys-sep" />
          <kbd>↵</kbd>
          <span>Select</span>
        </span>
      </div>
    </>
  )
}

/**
 * The gallery's workspace filter. The workspaces your apps on this computer
 * use come first, most recently used first, then the others A to Z.
 */
export function WorkspacePicker({
  recent,
  others,
  total,
  value,
  onChange
}: {
  /** The workspaces your apps here use, most recent first. */
  recent: readonly GalleryWorkspace[]
  /** The other workspaces, A to Z. */
  others: readonly GalleryWorkspace[]
  /** Every app's count, for All workspaces. */
  total: number
  value: string | null
  onChange: (id: string | null) => void
}): JSX.Element {
  const current = value ? [...recent, ...others].find((w) => w.id === value) : undefined
  return (
    <GalleryMenu
      icon={current ? workspaceIcon(current.name) : 'folder-library'}
      label={current ? workspaceTitle(current.name).title : 'All workspaces'}
      value={current?.name ?? 'All workspaces'}
      name="Workspace"
      width={400}
      panelClassName="gallery-ws-panel"
    >
      {(close) => (
        <WorkspaceList
          recent={recent}
          others={others}
          total={total}
          value={value}
          onPick={(id) => {
            onChange(id)
            close()
          }}
        />
      )}
    </GalleryMenu>
  )
}
