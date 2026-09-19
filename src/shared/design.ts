import type { DeployResult, PreviewDesignRestylePatch } from './ipc'

export type DesignJson =
  | null
  | boolean
  | number
  | string
  | DesignJson[]
  | { [key: string]: DesignJson }
export type DesignSource = 'local' | 'direct' | 'fabric'
export type DesignTool = 'select' | 'interact' | 'comment' | 'draw'
export type DesignBlock =
  | 'section'
  | 'row'
  | 'columns'
  | 'card'
  | 'heading'
  | 'text'
  | 'button'
  | 'image'

export interface DesignTarget {
  id: string
  selector: string
  tag: string
  label: string
  text?: string
  parentSelector?: string
  role?: string
  ariaLabel?: string
  component?: string
}

export interface DesignEdit {
  kind:
    | 'style'
    | 'text'
    | 'remove'
    | 'reorder'
    | 'insert'
    | 'image'
    | 'theme'
    | 'chart'
    | 'comment'
    | 'annotation'
  target: DesignTarget
  property?: string
  before: DesignJson
  after: DesignJson
  scope?: string
}

export interface DesignTransaction {
  id: string
  label: string
  route: string
  edits: DesignEdit[]
}

export interface DesignSelection extends DesignTarget {
  styles: Record<string, string>
  inlineStyles: Record<string, string>
  textEditable: boolean
  ownText: string
  width: number
  height: number
  parent?: DesignTarget
  children: DesignTarget[]
  image?: { src: string; alt: string }
  chart?: {
    spec: { [key: string]: DesignJson }
    types: { value: string; label: string; enabled: boolean }[]
  }
  canContain: boolean
  canReorder: boolean
}

export interface DesignToken {
  name: string
  value: string
  kind: 'color' | 'length' | 'font' | 'other'
  target: DesignTarget
}

export interface DesignConflict {
  transactionId: string
  message: string
}

export interface DesignVerification {
  transactionId: string
  ok: boolean
  message?: string
}

export interface DesignSnapshot {
  protocol: 1
  sessionId: string
  documentId: string
  revision: number
  enabled: boolean
  route: string
  tool: DesignTool
  compare: boolean
  selection: DesignSelection[]
  layers: DesignTarget[]
  tokens: DesignToken[]
  breakpoints: string[]
  viewport: { width: number; height: number }
  history: DesignTransaction[]
  cursor: number
  conflicts: DesignConflict[]
  acknowledged: string[]
  error?: string
  notice?: string
  verification?: DesignVerification[]
}

export interface DesignApplyReceipt {
  id: string
  projectId: string
  draftRevision: number
  turnId: string
  phase:
    | 'editing'
    | 'source-updated'
    | 'deploying'
    | 'deployed'
    | 'needs-review'
    | 'error'
    | 'interrupted'
  sourceRevisionBefore: string
  sourceRevisionAfter?: string
  filesModified: string[]
  error?: string
  deployment?: DeployResult
}

export interface DesignDraft {
  schemaVersion: 1
  projectId: string
  sessionId: string
  revision: number
  source: DesignSource
  route: string
  sourceRevision: string
  history: DesignTransaction[]
  cursor: number
  viewportWidth?: number
  receipt?: DesignApplyReceipt
}

export interface DesignAsset {
  id: string
  name: string
  mime: string
  size: number
  projectPath?: string
}

export interface DesignConnection {
  sessionId: string
  embedded: boolean
  appUrl: string
  history: DesignTransaction[]
  cursor: number
  revision: number
  route?: string
  assetPreviews?: Record<string, string>
}

export type DesignCommandBody =
  | { type: 'select'; target: DesignTarget; toggle?: boolean }
  | { type: 'tool'; tool: DesignTool }
  | {
      type: 'style'
      values: Record<string, string>
      scope?: string
      gestureId?: string
      phase?: 'preview' | 'commit' | 'cancel'
    }
  | { type: 'text'; value: string }
  | { type: 'undo' | 'redo' | 'reset' | 'discard' | 'clear' }
  | { type: 'revert'; transactionId: string }
  | { type: 'retarget'; transactionId: string; target: DesignTarget }
  | { type: 'compare'; enabled: boolean }
  | { type: 'move'; direction: 'previous' | 'next'; free?: boolean }
  | { type: 'freeMove'; enabled: boolean }
  | { type: 'remove' | 'duplicate' }
  | { type: 'insert'; block: DesignBlock; placement: 'inside' | 'before' | 'after' }
  | { type: 'image'; assetId: string; dataUrl: string; alt?: string }
  | { type: 'attribute'; name: 'alt'; value: string }
  | { type: 'theme'; values: { token: DesignToken; value: string }[] }
  | { type: 'chart'; patch: { [key: string]: DesignJson } }
  | { type: 'debug'; enabled: boolean }
  | { type: 'comment'; value: string }
  | { type: 'drawOptions'; shape: 'pen' | 'arrow' | 'rect' | 'ellipse'; color: string }
  | { type: 'restyle'; patch: PreviewDesignRestylePatch }
  | { type: 'generated'; html: string }
  | { type: 'capture'; enabled: boolean }
  | { type: 'verify'; history: DesignTransaction[]; cursor: number }

export type DesignCommand = DesignCommandBody & {
  sessionId: string
  documentId: string
  commandId: string
}

export interface DesignStudioApi {
  connect: (options: DesignConnection) => Promise<DesignSnapshot>
  poll: (sessionId: string) => Promise<DesignSnapshot | null>
  command: (command: DesignCommand) => Promise<DesignSnapshot>
  disconnect: (sessionId: string) => Promise<void>
  load: (projectId: string) => Promise<DesignDraft | null>
  save: (draft: DesignDraft) => Promise<number>
  clear: (projectId: string) => Promise<void>
  sourceRevision: (projectId: string) => Promise<string>
  assets: (projectId: string) => Promise<DesignAsset[]>
  importAsset: (projectId: string) => Promise<DesignAsset | null>
  assetPreview: (projectId: string, assetId: string) => Promise<string>
  apply: (
    projectId: string,
    applyId: string,
    revision: number,
    screenshotPath?: string
  ) => Promise<DesignApplyReceipt>
  receipt: (projectId: string) => Promise<DesignApplyReceipt | null>
  finish: (projectId: string, applyId: string, verified: boolean) => Promise<DesignApplyReceipt>
}
