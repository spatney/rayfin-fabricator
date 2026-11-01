import type { CSSProperties, JSX } from 'react'
import type { GalleryApp, GalleryStatus } from '@shared/ipc'
import { Codicon } from '../icons'
import { hueOf } from '../team/map/parts'
import { ago, initials } from './model'
import { WorkspaceName, workspaceIcon } from './WorkspacePicker'

/** A stable number for a name, to pick its cover's shapes. */
function hash(text: string): number {
  let h = 7
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h
}

/** Flat shapes over a tint of the app's hue: the same app always looks the same. */
const SHAPES: ReadonlyArray<JSX.Element> = [
  <>
    <circle className="gcover-a" cx="134" cy="8" r="48" />
    <circle className="gcover-b" cx="104" cy="66" r="15" />
  </>,
  <>
    <polygon className="gcover-a" points="86,70 160,-4 160,30 124,70" />
    <circle className="gcover-b" cx="148" cy="56" r="9" />
  </>,
  <>
    <path className="gcover-a" d="M160,70 L160,2 A68,68 0 0 0 92,70 Z" />
    <circle className="gcover-ring" cx="112" cy="20" r="11" />
  </>,
  <>
    <circle className="gcover-a" cx="152" cy="74" r="56" />
    <circle className="gcover-b" cx="152" cy="74" r="32" />
  </>
]

/** An app's cover: a flat tint of its hue, a few shapes, and its initials. */
export function AppCover({
  name,
  className = ''
}: {
  name: string
  className?: string
}): JSX.Element {
  return (
    <span
      className={`gcover ${className}`.trim()}
      style={{ '--hue': hueOf(name) } as CSSProperties}
      aria-hidden="true"
    >
      <svg
        className="gcover-svg"
        viewBox="0 0 160 70"
        preserveAspectRatio="xMidYMid slice"
        focusable="false"
      >
        <rect className="gcover-bg" width="160" height="70" />
        {SHAPES[hash(name) % SHAPES.length]}
      </svg>
      <span className="gcover-mark">{initials(name)}</span>
    </span>
  )
}

/** "Published 3 days ago", "Not published yet", or nothing while Fabric hasn't said. */
export function publishedText(status: GalleryStatus | undefined): string | undefined {
  if (!status || status.unknown) return undefined
  const when = ago(status.publishedAt)
  return when ? `Published ${when}` : 'Not published yet'
}

/** Small dots and words: where the app lives besides Fabric. */
export function AppTags({ app }: { app: GalleryApp }): JSX.Element | null {
  if (!app.local && !app.team) return null
  return (
    <>
      {app.local && (
        <span className="gtag">
          <span className="gdot gdot--local" aria-hidden="true" />
          On this computer
        </span>
      )}
      {app.team && (
        <span className="gtag" title={`Team workspace ${app.team.name}`}>
          <span
            className={`gdot ${app.team.preview ? 'gdot--preview' : 'gdot--team'}`}
            aria-hidden="true"
          />
          {app.team.preview ? 'Team preview' : app.team.name}
        </span>
      )}
    </>
  )
}

/** One app in the gallery, with its pin in the corner. */
export default function AppCard({
  app,
  status,
  selected,
  pinned = false,
  showWorkspace = true,
  onSelect,
  onPin
}: {
  app: GalleryApp
  status?: GalleryStatus
  selected: boolean
  pinned?: boolean
  /** Off under a workspace's own heading. */
  showWorkspace?: boolean
  onSelect: (app: GalleryApp) => void
  /** Pin or unpin the app; `keyboard` when the keyboard pressed the pin, not a pointer. */
  onPin: (app: GalleryApp, keyboard: boolean) => void
}): JSX.Element {
  const published = publishedText(status)
  const descId = `gcard-desc-${app.id}`
  return (
    <li className="gcard-item">
      <button
        type="button"
        className={`gcard${selected ? ' gcard--selected' : ''}`}
        aria-label={`${app.name}, in ${app.workspaceName}`}
        aria-describedby={descId}
        aria-pressed={selected}
        data-app-id={app.id}
        onClick={() => onSelect(app)}
      >
        <AppCover name={app.name} />
        <span className="gcard-body">
          <span className="gcard-name" title={app.name}>
            {app.name}
          </span>
          {showWorkspace && (
            <span className="gcard-ws" title={app.workspaceName}>
              <Codicon name={workspaceIcon(app.workspaceName)} />
              <span>
                <WorkspaceName name={app.workspaceName} />
              </span>
            </span>
          )}
          {app.description && <span className="gcard-desc">{app.description}</span>}
          <span className="gcard-meta" id={descId}>
            <AppTags app={app} />
            {published ? (
              <span className="gcard-time">{published}</span>
            ) : (
              !status && (
                <span
                  className="gcard-time gcard-time--pending skeleton-pulse"
                  aria-hidden="true"
                />
              )
            )}
          </span>
        </span>
      </button>
      <button
        type="button"
        className="icon-btn gcard-pin"
        aria-label={`Pin ${app.name}`}
        aria-pressed={pinned}
        title={pinned ? 'Unpin' : 'Pin to the top'}
        onClick={(event) => {
          event.stopPropagation()
          onPin(app, event.detail === 0)
        }}
      >
        <Codicon name={pinned ? 'pinned' : 'pin'} />
      </button>
    </li>
  )
}

/** A card-shaped placeholder while the apps load. */
export function SkeletonCard({ index }: { index: number }): JSX.Element {
  return (
    <li className="gcard-item" aria-hidden="true">
      <span className="gcard gcard--skeleton">
        <span className="gcover gcover--skeleton skeleton-pulse" />
        <span className="gcard-body">
          <span
            className="skeleton-bar skeleton-pulse"
            style={{ width: `${62 - (index % 3) * 12}%` }}
          />
          <span
            className="skeleton-bar skeleton-bar--sm skeleton-pulse"
            style={{ width: `${40 + (index % 2) * 14}%` }}
          />
        </span>
      </span>
    </li>
  )
}
