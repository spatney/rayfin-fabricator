import type { HTMLAttributes, SVGProps } from 'react'

/**
 * Small, monochrome line icons shared across the app's control clusters
 * (titlebar, deployment control, preview toolbar). They all stroke with
 * `currentColor` and default to the `.btn-ico` size so they inherit a button's
 * text color and sit beside a label. Pass a `className` to resize (e.g. icon-only
 * segments bump these to 16px via `.seg-btn--icon .btn-ico`).
 */
type IconProps = SVGProps<SVGSVGElement>

/**
 * VS Code codicon (font-based). Use for universally-recognized glyphs that
 * previously used raw unicode (carets, refresh, edit, search). `name` is the
 * codicon id without the `codicon-` prefix, e.g. `chevron-down`.
 */
export function Codicon({
  name,
  className = '',
  ...rest
}: { name: string } & HTMLAttributes<HTMLElement>): JSX.Element {
  return <i className={`codicon codicon-${name} ${className}`.trim()} aria-hidden="true" {...rest} />
}

function Icon({ className = 'btn-ico', children, ...rest }: IconProps): JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  )
}

/** Circled "i" — Report an issue. */
export function InfoIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </Icon>
  )
}

/** Gear — Settings. */
export function GearIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Icon>
  )
}

/** Sign-out — door with an exiting arrow. */
export function SignOutIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </Icon>
  )
}

/** House — go back to the Home / projects landing. */
export function HomeIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5 10v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9" />
      <path d="M9.5 20v-6h5v6" />
    </Icon>
  )
}

/** Stacked layers — view inside the Fabric portal shell. */
export function FabricIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M12 3 3 8l9 5 9-5-9-5Z" />
      <path d="M3 13l9 5 9-5" />
      <path d="M3 18l9 5 9-5" opacity="0.5" />
    </Icon>
  )
}

/** Cursor selecting inside a frame — the in-preview design / tweak mode. */
export function DesignIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M14 3H3v11" opacity="0.5" />
      <path d="m8 8 12 5-5 2-2 5-5-12Z" />
    </Icon>
  )
}

/** Corner arrows pointing out — enter focus / full-width preview. */
export function ExpandIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <polyline points="9 3 3 3 3 9" />
      <polyline points="15 3 21 3 21 9" />
      <polyline points="21 15 21 21 15 21" />
      <polyline points="3 15 3 21 9 21" />
    </Icon>
  )
}

/** Corner arrows pointing in — exit focus / show chat again. */
export function CollapseIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <polyline points="3 9 9 9 9 3" />
      <polyline points="21 9 15 9 15 3" />
      <polyline points="15 21 15 15 21 15" />
      <polyline points="9 21 9 15 3 15" />
    </Icon>
  )
}

/** Chevron left — preview back. */
export function ChevronLeftIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <polyline points="15 18 9 12 15 6" />
    </Icon>
  )
}

/** Chevron right — preview forward. */
export function ChevronRightIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <polyline points="9 18 15 12 9 6" />
    </Icon>
  )
}

/** Circular arrow — reload the preview. */
export function ReloadIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <polyline points="21 4 21 10 15 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L21 8" />
    </Icon>
  )
}

/** Clock — a pending / queued item waiting its turn. */
export function ClockIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Icon>
  )
}

/** Four-point sparkle — the AI model selector. */
export function SparkleIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3Z" />
      <path d="M19 3.5v3" />
      <path d="M20.5 5h-3" />
    </Icon>
  )
}

/** Eraser — clear the current conversation. */
export function EraserIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
      <path d="M22 21H7" />
      <path d="m5 11 9 9" />
    </Icon>
  )
}

/** Git-branch / fork glyph. */
export function BranchIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </Icon>
  )
}

/** Plain "×" — discard / close. */
export function CloseIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Icon>
  )
}

/** Filled rounded square — stop the in-flight turn. */
export function StopIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" stroke="none" />
    </Icon>
  )
}

/** Framed picture — a screenshot attachment. */
export function ImageIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="m21 15-5-5L5 21" />
    </Icon>
  )
}

/** Window with code chevrons — Open in an external editor (VS Code). */
export function EditorIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 9l-2.5 3L9 15" />
      <path d="M15 9l2.5 3L15 15" />
    </Icon>
  )
}

/** Magnifier — Search/filter. */
export function SearchIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </Icon>
  )
}

/** Overlapping pages — Copy to clipboard. */
export function CopyIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </Icon>
  )
}

/** Speech bubble — Send to chat / ask the agent. */
export function ChatIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 9 9 0 0 1-3.8-.8L3 21l1.8-5.4A8.38 8.38 0 0 1 4 11.5 8.5 8.5 0 0 1 21 11.5z" />
    </Icon>
  )
}

/** Two arrows — Compare two snapshots. */
export function CompareIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M7 4v13" />
      <path d="M4 7l3-3 3 3" />
      <path d="M17 20V7" />
      <path d="M14 17l3 3 3-3" />
    </Icon>
  )
}

/** Clock with a counter-arrow — File history / past versions. */
export function HistoryIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M3 3v5h5" />
      <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
      <path d="M12 7v5l3 2" />
    </Icon>
  )
}

/** Shield — Authentication / who can sign in. */
export function ShieldIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M12 3 5 6v5c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3Z" />
      <path d="m9.2 12 2 2 3.6-3.8" />
    </Icon>
  )
}

/** Key — a sign-in credential (e.g. email & password). */
export function KeyIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="4" />
      <path d="m11 11 8 8" />
      <path d="m16 16 2-2" />
      <path d="m19 13 2-2" />
    </Icon>
  )
}

/** Stacked disks — Database / your app's data. */
export function DatabaseIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    </Icon>
  )
}

/** Globe — Hosting / your live website. */
export function GlobeIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.5 2.5 3.8 5.7 3.8 9S14.5 18.5 12 21c-2.5-2.5-3.8-5.7-3.8-9S9.5 5.5 12 3Z" />
    </Icon>
  )
}

/** Checkmark — a satisfied / completed state. */
export function CheckIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <polyline points="20 6 9 17 4 12" />
    </Icon>
  )
}

/** Down arrow into a tray — install / download. */
export function DownloadIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M12 3v12" />
      <polyline points="7 11 12 16 17 11" />
      <path d="M5 19h14" />
    </Icon>
  )
}

/** Cloud — Azure / cloud resources. */
export function CloudIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M7 18a4 4 0 0 1-.5-7.97 5.5 5.5 0 0 1 10.6 1.02A3.5 3.5 0 0 1 16.5 18Z" />
    </Icon>
  )
}

/** Isometric cube — Node.js runtime. */
export function CubeIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7Z" />
      <path d="M3.7 7.2 12 12l8.3-4.8" />
      <path d="M12 12v9.5" />
    </Icon>
  )
}

/** Shipping box — an npm package. */
export function PackageIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7Z" />
      <path d="M3.7 7.2 12 12l8.3-4.8" />
      <path d="M12 12v9.5" />
      <path d="M7.8 4.7 16 9.4" />
    </Icon>
  )
}

/** Terminal — a command-line tool. */
export function TerminalIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3" />
      <path d="M13 15h4" />
    </Icon>
  )
}

/** Lightning bolt — runtime / query performance. */
export function BoltIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />
    </Icon>
  )
}

/** Universal-access figure — frontend accessibility. */
export function AccessibilityIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="4.5" r="1.6" />
      <path d="M4 8.5c2.6 1.1 5.2 1.6 8 1.6s5.4-.5 8-1.6" />
      <path d="M12 10v5" />
      <path d="m8.5 21 3.5-6 3.5 6" />
    </Icon>
  )
}
