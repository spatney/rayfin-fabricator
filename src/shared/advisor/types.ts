/**
 * Advisor data model shared by the renderer and (via mirrored serde DTOs in
 * `src-tauri/src/types.rs`) the Rust backend.
 *
 * The rule catalog itself lives in `rules.json` next to this file and is read by
 * both sides: the renderer runs the `quick` rules deterministically, and the
 * backend builds the Copilot deep-review prompt from the `ai` rules.
 */

export type AdvisorCategoryId =
  | 'access'
  | 'policy'
  | 'secrets'
  | 'data-model'
  | 'queries'
  | 'config'
  | 'platform'
  | 'performance'
  | 'accessibility'

/** `note` is informational: shown, but never counted as an issue or scored. */
export type AdvisorSeverity = 'high' | 'medium' | 'low' | 'note'

/** `quick` rules run instantly in the app; `ai` rules run in the Copilot deep review. */
export type AdvisorEngine = 'quick' | 'ai'

/** Project traits a rule can require before it applies (any one must hold). */
export type AdvisorCondition =
  | 'data'
  | 'auth'
  | 'fabricSso'
  | 'storage'
  | 'functions'
  | 'connectors'
  | 'hosting'

export interface AdvisorDocLink {
  title: string
  url: string
}

export interface AdvisorRuleDef {
  id: string
  category: AdvisorCategoryId
  engine: AdvisorEngine
  severity: AdvisorSeverity
  appliesWhen?: AdvisorCondition[]
  /** Headline used when the rule fails. */
  title: string
  /** What the rule checks, phrased as the passing state ("Every entity …"). */
  summary: string
  why: string
  fix: string
  /** Instructions for the deep review (`ai` rules only). */
  check?: string
  docs: AdvisorDocLink[]
}

export interface AdvisorCategoryDef {
  id: AdvisorCategoryId
  title: string
  description: string
  docs: AdvisorDocLink[]
}

export interface AdvisorCatalog {
  catalogVersion: string
  /** The Rayfin release the rules were written against. */
  rayfinBaseline: string
  categories: AdvisorCategoryDef[]
  rules: AdvisorRuleDef[]
}

/** Where a finding came from. */
export type AdvisorSource = 'quick' | 'ai'

export interface AdvisorLocation {
  file: string
  line?: number
  endLine?: number
  /** Short description of what's at this location (e.g. an entity or field name). */
  label?: string
}

/** One issue surfaced by a quick check or the Copilot deep review. */
export interface AdvisorFinding {
  /**
   * Stable id: `quick:<ruleId>` or `ai:<ruleId>` — one grouped finding per rule,
   * so the same issue keeps its id across runs even when a review picks a
   * different primary place. Used for dismissals, hand-offs, and "new"/"resolved"
   * tracking. Legacy reviews use a slug.
   */
  id: string
  /** Catalog rule id; `legacy/<category>` for reviews from before the catalog. */
  ruleId: string
  category: AdvisorCategoryId | string
  severity: AdvisorSeverity | string
  source: AdvisorSource
  title: string
  /** What's wrong here and why it matters. */
  detail: string
  /** A concrete suggested fix. */
  recommendation: string
  /** Project-relative path the issue lives in, when known. */
  file?: string
  /** 1-based first line of the evidence. */
  line?: number
  /** 1-based last line of the evidence. */
  endLine?: number
  /** Code excerpt around the evidence (secret-looking values masked). */
  excerpt?: string
  /** 1-based line number of the excerpt's first line. */
  excerptStart?: number
  /** Evidence was checked against the file (always true for quick checks). */
  verified?: boolean
  confidence?: 'high' | 'medium' | 'low'
  /** A finding-specific doc link (e.g. the page a live-guidance finding cites). */
  docsUrl?: string
  /** Further places the same issue occurs. */
  locations?: AdvisorLocation[]
}

export type AdvisorRuleStatus = 'pass' | 'fail' | 'na' | 'skipped'

export interface AdvisorRuleResult {
  ruleId: string
  status: AdvisorRuleStatus
  note?: string
}

/** The deep-review report (persisted and reloaded across runs). */
export interface AdvisorReport {
  /** True when the review completed. */
  ok: boolean
  /** One or two sentence overview (or an error message when ok is false). */
  summary: string
  findings: AdvisorFinding[]
  /** Outcome of each deep-review rule evaluated (absent for legacy reviews). */
  rules?: AdvisorRuleResult[]
}

/** A saved deep review: the report plus when it ran, how long it took, and staleness. */
export interface AdvisorSnapshot {
  /** 2 for catalog-based reviews; absent for legacy reviews. */
  schemaVersion?: number
  report: AdvisorReport
  /** RFC3339 timestamp of when the review completed. */
  analyzedAt: string
  /** Wall-clock duration of the review, in milliseconds. */
  durationMs: number
  /** True when the project's code changed since this review (recomputed on load). */
  stale: boolean
  /** Rule catalog version the review ran with. */
  catalogVersion?: string
  /** Copilot model used (absent for Auto). */
  model?: string
  /** Rayfin CLI version installed when the review ran. */
  rayfinVersion?: string
}

/* ------------------------------------------------------------------ *
 * Quick-check inputs
 * ------------------------------------------------------------------ */

export interface AdvisorProjectFile {
  /** Project-relative POSIX path. */
  path: string
  size: number
  /** True when git ignores the file (absent otherwise). */
  ignored?: boolean
}

/** An installed or declared `@microsoft/rayfin-*` package. */
export interface AdvisorPackage {
  name: string
  /** Version resolved in node_modules. */
  installed?: string
  /** Range declared in package.json. */
  declared?: string
  dev?: boolean
}

/** Everything the quick checks read, gathered in one IPC round-trip. */
export interface AdvisorProjectSnapshot {
  /** Every project file outside heavy/generated folders. */
  files: AdvisorProjectFile[]
  /** Text contents of the files the rules read, keyed by path. */
  contents: Record<string, string>
  /** True when the file walk or content collection hit its caps. */
  truncated?: boolean
  /** The project is a git work tree (so `ignored` flags are meaningful). */
  isGitRepo: boolean
  packages: AdvisorPackage[]
}

/* ------------------------------------------------------------------ *
 * Deep review requests
 * ------------------------------------------------------------------ */

/** Project facts the deep review is grounded on (computed by the quick checks). */
export interface AdvisorFacts {
  /** Enabled rayfin.yml services (e.g. `auth`, `data`, `staticHosting`). */
  services: string[]
  /** Which rule conditions hold for this project. */
  conditions: AdvisorCondition[]
  entities: { name: string; file: string; access: string }[]
  versions: { name: string; installed?: string; latest?: string }[]
  /** Short description of the app's shape (e.g. "React + Vite, Fabric SSO"). */
  stack?: string
}

/** A quick-check finding the deep review should not repeat. */
export interface AdvisorQuickRef {
  ruleId: string
  title: string
  file?: string
  line?: number
}

export interface AdvisorRunRequest {
  model?: string
  effort?: string
  /** With Auto, what it optimizes for. */
  autoTier?: string
  /** With a model that offers several, its context window. */
  contextTier?: string
  facts: AdvisorFacts
  quick: AdvisorQuickRef[]
  /** Open findings from the last deep review, re-checked rather than rediscovered. */
  previous?: AdvisorQuickRef[]
}

export type AdvisorVerdictStatus = 'fixed' | 'present' | 'unclear'

export interface AdvisorVerdict {
  findingId: string
  status: AdvisorVerdictStatus
  note?: string
}

/* ------------------------------------------------------------------ *
 * Renderer-owned lifecycle state (persisted as opaque JSON)
 * ------------------------------------------------------------------ */

export type AdvisorDismissReason = 'false-positive' | 'accepted-risk'

export interface AdvisorDismissal {
  reason: AdvisorDismissReason
  note?: string
  at: string
  title: string
  ruleId: string
}

export interface AdvisorMute {
  at: string
  note?: string
}

/** A finding handed to the Build chat for Copilot to fix. */
export interface AdvisorHandoff {
  at: string
  source: AdvisorSource
  /** The chat turn that received the hand-off has started. */
  started?: boolean
  /** When that turn finished. */
  appliedAt?: string
}

/** Enough about a finding to show it after it stops being detected. */
export interface AdvisorFindingRecord {
  title: string
  ruleId: string
  severity: string
  category: string
  source: AdvisorSource
  file?: string
}

/** One finding a chat message handed to Copilot, as the message's card shows it. */
export interface ChatAdvisorFix extends AdvisorFindingRecord {
  /** The finding's id, used to follow where it stands in the Advisor. */
  id: string
  line?: number
  /** How many places the issue occurs, when more than one. */
  places?: number
}

/** The Advisor findings a (user) message handed to Copilot to fix, most severe first. */
export interface ChatAdvisorSummary {
  fixes: ChatAdvisorFix[]
}

export interface AdvisorResolved extends AdvisorFindingRecord {
  at: string
  /** How the resolution was noticed. */
  via: 'quick' | 'review' | 'verify'
  /** The fix was handed to Copilot before it resolved. */
  fixedByCopilot?: boolean
}

/** Open findings at a point in time, used for "new" and "resolved" tracking. */
export interface AdvisorFindingSet {
  at: string
  /** `review` when captured as a deep review finished; `quick` for the first quick check. */
  kind: 'quick' | 'review'
  entries: Record<string, AdvisorFindingRecord>
}

export interface AdvisorUiState {
  version: 1
  dismissed: Record<string, AdvisorDismissal>
  muted: Record<string, AdvisorMute>
  handoffs: Record<string, AdvisorHandoff>
  resolved: Record<string, AdvisorResolved>
  /** Findings open at the previous deep review — "new" is measured against this. */
  baseline?: AdvisorFindingSet
  /** Findings open when the latest deep review finished. */
  latest?: AdvisorFindingSet
  /** Quick-check findings open at the previous quick-check run. */
  lastQuick?: Record<string, AdvisorFindingRecord>
  /** Verify outcomes for deep-review findings. */
  verdicts?: Record<string, { status: AdvisorVerdictStatus; note?: string; at: string }>
}

export interface AdvisorLoadResult {
  snapshot: AdvisorSnapshot | null
  state: AdvisorUiState | null
}
