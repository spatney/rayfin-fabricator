import type { SVGProps } from 'react'

/**
 * Small, monochrome line icons shared across the app's control clusters
 * (titlebar, deployment control, preview toolbar). They all stroke with
 * `currentColor` and default to the `.btn-ico` size so they inherit a button's
 * text color and sit beside a label. Pass a `className` to resize (e.g. icon-only
 * segments bump these to 16px via `.seg-btn--icon .btn-ico`).
 */
type IconProps = SVGProps<SVGSVGElement>

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

/** Cookie with chips — clear the preview's cookies / cached sign-in. */
export function CookieIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M12 3a9 9 0 1 0 9 9 3 3 0 0 1-3.6-3.6A3 3 0 0 1 12 3Z" />
      <circle cx="9" cy="11" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="13" cy="9.5" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="14" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="9.5" cy="15" r="0.9" fill="currentColor" stroke="none" />
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

/** Pencil — annotate the preview. */
export function AnnotateIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
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

/** Git-branch / fork — start a parallel side thread. */
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
