import type { SVGProps } from 'react'
import {
  Accessibility20Regular,
  Add20Regular,
  Apps20Regular,
  ArrowClockwise20Regular,
  ArrowDownload20Regular,
  ArrowMaximize20Regular,
  ArrowMinimize20Regular,
  ArrowSwap20Regular,
  ArrowSync20Regular,
  Box20Regular,
  Branch20Regular,
  BranchCompare20Regular,
  BranchFork20Regular,
  Chat20Regular,
  Checkmark20Regular,
  CheckmarkCircle20Regular,
  ChevronDown20Regular,
  ChevronLeft20Regular,
  ChevronRight20Regular,
  ChevronUp20Regular,
  Circle20Regular,
  Clock20Regular,
  Cloud20Regular,
  Code20Regular,
  Comment20Regular,
  CompassNorthwest20Regular,
  Copy20Regular,
  Cube20Regular,
  Database20Regular,
  DesignIdeas20Regular,
  Dismiss20Regular,
  Document20Regular,
  Edit20Regular,
  Eraser20Regular,
  ErrorCircle20Regular,
  Eye20Regular,
  EyeOff20Regular,
  Flash20Regular,
  Folder20Regular,
  FullScreenMaximize20Regular,
  FullScreenMinimize20Regular,
  Globe20Regular,
  History20Regular,
  Home20Regular,
  Image20Regular,
  Info20Regular,
  Key20Regular,
  Layer20Regular,
  Link20Regular,
  Open20Regular,
  PanelLeftContract20Regular,
  PanelLeftExpand20Regular,
  Person20Regular,
  Play20Regular,
  Prohibited20Regular,
  QuestionCircle20Regular,
  Search20Regular,
  Settings20Regular,
  ShieldCheckmark20Regular,
  SignOut20Regular,
  Sparkle20Regular,
  Stop20Filled,
  Table20Regular,
  TaskListLtr20Regular,
  Warning20Regular,
  WindowConsole20Regular,
  Wrench20Regular,
  ZoomIn20Regular,
  ZoomOut20Regular,
  type FluentIcon,
  type FluentIconsProps
} from '@fluentui/react-icons'

/**
 * Shared icon set for the app's control clusters (titlebar, nav rail, composer,
 * toolbars, setup meters). Every glyph is a **Microsoft Fluent UI v2 / Fluent 9
 * icon** (`@fluentui/react-icons`), rendered as an SVG that fills with
 * `currentColor` so it inherits its button's text color. Sizing is driven by the
 * caller's `className` (defaults to `.btn-ico`, 14px); the intrinsic 20px design
 * size is overridden by CSS width/height like the previous hand-rolled set.
 *
 * The wrapper names are kept stable so call sites never change when the
 * underlying Fluent glyph is swapped.
 */
type IconProps = SVGProps<SVGSVGElement>

export function InfoIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <Info20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function AddIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <Add20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function FolderIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <Folder20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function GearIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <Settings20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function SignOutIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <SignOut20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function HomeIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <Home20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function ProjectsIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <Apps20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function SidebarExpandIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <PanelLeftExpand20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function SidebarCollapseIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <PanelLeftContract20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function FabricIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <Layer20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function DesignIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <DesignIdeas20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function ExpandIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <FullScreenMaximize20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function CollapseIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <FullScreenMinimize20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function ChevronLeftIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <ChevronLeft20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function ChevronRightIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <ChevronRight20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function ChevronDownIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <ChevronDown20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function ReloadIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <ArrowClockwise20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function ClockIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <Clock20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function SparkleIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <Sparkle20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function EraserIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <Eraser20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function BranchIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <Branch20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function CloseIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <Dismiss20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function StopIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <Stop20Filled className={className} {...(rest as FluentIconsProps)} />
}

export function ImageIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <Image20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function EditorIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <Code20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function SearchIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <Search20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function CopyIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <Copy20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function ChatIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <Chat20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function CompareIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <ArrowSwap20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function HistoryIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <History20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function ShieldIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <ShieldCheckmark20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function KeyIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <Key20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function DatabaseIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <Database20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function GlobeIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <Globe20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function CheckIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <Checkmark20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function OpenExternalIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <Open20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function DownloadIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <ArrowDownload20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function CloudIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <Cloud20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function CubeIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <Cube20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function PackageIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <Box20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function TerminalIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <WindowConsole20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function BoltIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <Flash20Regular className={className} {...(rest as FluentIconsProps)} />
}

export function AccessibilityIcon({ className = 'btn-ico', ...rest }: IconProps): JSX.Element {
  return <Accessibility20Regular className={className} {...(rest as FluentIconsProps)} />
}

/**
 * Maps the legacy VS Code codicon names still referenced across the app to their
 * Fluent 9 equivalents. Lets the many `<Codicon name="…"/>` call sites (including
 * dynamic ones) switch to Fluent glyphs without touching every site.
 */
const CODICON_MAP: Record<string, FluentIcon> = {
  check: Checkmark20Regular,
  'check-all': CheckmarkCircle20Regular,
  refresh: ArrowClockwise20Regular,
  sync: ArrowSync20Regular,
  warning: Warning20Regular,
  error: ErrorCircle20Regular,
  'chevron-down': ChevronDown20Regular,
  'chevron-right': ChevronRight20Regular,
  'chevron-up': ChevronUp20Regular,
  edit: Edit20Regular,
  search: Search20Regular,
  close: Dismiss20Regular,
  eye: Eye20Regular,
  'eye-closed': EyeOff20Regular,
  'expand-all': ArrowMaximize20Regular,
  'collapse-all': ArrowMinimize20Regular,
  'zoom-out': ZoomOut20Regular,
  'zoom-in': ZoomIn20Regular,
  'screen-full': FullScreenMaximize20Regular,
  copy: Copy20Regular,
  'desktop-download': ArrowDownload20Regular,
  diff: BranchCompare20Regular,
  'link-external': Open20Regular,
  table: Table20Regular,
  key: Key20Regular,
  link: Link20Regular,
  'comment-discussion': Comment20Regular,
  folder: Folder20Regular,
  terminal: WindowConsole20Regular,
  database: Database20Regular,
  globe: Globe20Regular,
  file: Document20Regular,
  'circle-large-outline': Circle20Regular,
  'circle-slash': Prohibited20Regular,
  compass: CompassNorthwest20Regular,
  question: QuestionCircle20Regular,
  checklist: TaskListLtr20Regular,
  play: Play20Regular,
  account: Person20Regular,
  tools: Wrench20Regular,
  'repo-clone': BranchFork20Regular,
  'settings-gear': Settings20Regular
}

/**
 * Renders a Fluent 9 glyph for a codicon `name` (e.g. `chevron-down`). The
 * `.fluent-codicon` class sizes the SVG to `1em`, so the many callers that sized
 * the old font glyph via `font-size` keep working unchanged. Any name not yet in
 * the map falls back to the codicon web font so nothing renders blank.
 */
export function Codicon({
  name,
  className,
  ...rest
}: { name: string } & FluentIconsProps): JSX.Element {
  const Glyph = CODICON_MAP[name]
  if (Glyph) {
    const cls = className ? `fluent-codicon ${className}` : 'fluent-codicon'
    return <Glyph aria-hidden {...rest} className={cls} />
  }
  return (
    <i
      className={`codicon codicon-${name}${className ? ` ${className}` : ''}`}
      aria-hidden="true"
    />
  )
}
