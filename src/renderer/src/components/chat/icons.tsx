import type { ChatMode } from '@shared/ipc'
import type { ToolKind } from './toolPresentation'

/** Distinct line icon per tool kind, so the activity feed is scannable at a glance. */
export function ToolKindIcon({
  kind,
  className
}: {
  kind: ToolKind
  className?: string
}): JSX.Element {
  const p = {
    className: className ?? 'btn-ico',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true
  }
  switch (kind) {
    case 'read':
      return (
        <svg {...p}>
          <path d="M7 3.5h7L18 7.5V20.5H7z" />
          <path d="M14 3.5V8h4" />
          <path d="M9.5 12.5h6M9.5 16h6" />
        </svg>
      )
    case 'edit':
    case 'design':
      return (
        <svg {...p}>
          <path d="M4 20h4L19 9l-4-4L4 16z" />
          <path d="M13.5 6.5l4 4" />
        </svg>
      )
    case 'create':
      return (
        <svg {...p}>
          <path d="M7 3.5h7L18 7.5V20.5H7z" />
          <path d="M14 3.5V8h4" />
          <path d="M12 11.5v5M9.5 14h5" />
        </svg>
      )
    case 'search':
    case 'find':
      return (
        <svg {...p}>
          <circle cx="11" cy="11" r="6" />
          <path d="M20 20l-3.6-3.6" />
        </svg>
      )
    case 'run':
    case 'shell-io':
    case 'console':
      return (
        <svg {...p}>
          <rect x="3.5" y="5" width="17" height="14" rx="2" />
          <path d="M7 10l3 2.5L7 15" />
          <path d="M12.5 15h4" />
        </svg>
      )
    case 'web':
    case 'web-search':
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M3.5 12h17" />
          <path d="M12 3.5c2.4 2.4 3.4 5.3 3.4 8.5s-1 6.1-3.4 8.5c-2.4-2.4-3.4-5.3-3.4-8.5s1-6.1 3.4-8.5z" />
        </svg>
      )
    case 'todo':
      return (
        <svg {...p}>
          <path d="M10 6.5h9M10 12h9M10 17.5h9" />
          <path d="M4.5 6.2l1.2 1.3 2-2.3" />
          <path d="M4.5 11.7l1.2 1.3 2-2.3" />
          <path d="M4.8 17.5h2.4" />
        </svg>
      )
    case 'model':
      return (
        <svg {...p}>
          <ellipse cx="12" cy="6.5" rx="7" ry="2.8" />
          <path d="M5 6.5v11c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-11" />
          <path d="M5 12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8" />
        </svg>
      )
    case 'skill':
      return (
        <svg {...p}>
          <path d="M5 4.5h10.5A3.5 3.5 0 0 1 19 8v11.5H8.5A3.5 3.5 0 0 1 5 16z" />
          <path d="M5 16a3.5 3.5 0 0 1 3.5-3.5H19" />
        </svg>
      )
    case 'agent':
      return (
        <svg {...p}>
          <circle cx="9" cy="9" r="3" />
          <circle cx="16.5" cy="10.5" r="2.3" />
          <path d="M3.8 19c.6-3 2.7-4.8 5.2-4.8s4.6 1.8 5.2 4.8" />
          <path d="M14.8 15.2c2.6-.5 4.8 1 5.4 3.8" />
        </svg>
      )
    case 'delete':
      return (
        <svg {...p}>
          <path d="M5 7h14" />
          <path d="M9 7V4.5h6V7" />
          <path d="M6.5 7l1 12.5h9l1-12.5" />
        </svg>
      )
    case 'deploy':
      return (
        <svg {...p}>
          <path d="M6 16.5A3.5 3.5 0 0 1 6.5 9.6 5 5 0 0 1 16 8.8a3.6 3.6 0 0 1 2 6.7" />
          <path d="M12 12v7" />
          <path d="M9.5 14.5 12 12l2.5 2.5" />
        </svg>
      )
    case 'navigate':
    case 'scroll':
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M15.5 8.5 13 13l-4.5 2.5L11 11z" />
        </svg>
      )
    case 'screenshot':
      return (
        <svg {...p}>
          <path d="M4 8.5h3l1.5-2h7L17 8.5h3v10H4z" />
          <circle cx="12" cy="13" r="3" />
        </svg>
      )
    default:
      return (
        <svg {...p}>
          <path d="M12 4.5l1.9 4.6 4.6 1.9-4.6 1.9L12 17.5l-1.9-4.6L5.5 11l4.6-1.9z" />
        </svg>
      )
  }
}

export function CopyIcon({ className }: { className?: string }): JSX.Element {
  return (
    <svg
      className={className ?? 'btn-ico'}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </svg>
  )
}

export function CheckIcon({ className }: { className?: string }): JSX.Element {
  return (
    <svg
      className={className ?? 'btn-ico'}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6L9 17l-5-5" />
    </svg>
  )
}

export function SendIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 19V5" />
      <path d="M5 12l7-7 7 7" />
    </svg>
  )
}

/** Small glyph per chat mode, shown in the composer mode selector + its menu. */
export function ModeIcon({ mode, className }: { mode: ChatMode; className?: string }): JSX.Element {
  const cls = className ?? 'btn-ico'
  if (mode === 'plan') {
    return (
      <svg
        className={cls}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M10 6h8" />
        <path d="M10 12h8" />
        <path d="M10 18h8" />
        <path d="M4 5.4l1.2 1.3L7.6 4.3" />
        <path d="M4.2 12h2.4" />
        <path d="M4.2 18h2.4" />
      </svg>
    )
  }
  if (mode === 'autopilot') {
    return (
      <svg
        className={cls}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M4.5 6.5 11 12l-6.5 5.5z" />
        <path d="M12.5 6.5 19 12l-6.5 5.5z" />
      </svg>
    )
  }
  return (
    <svg
      className={cls}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4.5" y="8" width="15" height="11" rx="3" />
      <path d="M12 4.6V8" />
      <circle cx="12" cy="4" r="1.1" />
      <circle cx="9.6" cy="13" r="1.15" />
      <circle cx="14.4" cy="13" r="1.15" />
    </svg>
  )
}
