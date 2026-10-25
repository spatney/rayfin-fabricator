/**
 * How far a deploy has got, read from its `rayfin up` log as it streams.
 *
 * Rayfin 1.35 and newer report progress as `[rayfin] <phase>: <message>` lines,
 * which is what a piped `rayfin up` prints. Each phase becomes a step, in the
 * order the CLI reports them, and the CLI's message is kept as the step's
 * detail. A phase this file doesn't know still becomes a step, labelled with the
 * CLI's own words, so a newer CLI can add steps without breaking the screen.
 *
 * Older CLIs print emoji lines and stream the build instead. Their steps are
 * found by matching loose fragments of that output ({@link LEGACY_PHASES}),
 * with a gentle time floor for silent stretches.
 *
 * Until either kind of evidence shows up, the deploy is "connecting". Whatever
 * the log says, steps only move forward, so an odd line can never send the
 * screen backwards.
 */

export type DeployStepId =
  | 'packages'
  | 'connect'
  | 'capacity'
  | 'workspace'
  | 'item'
  | 'settings'
  | 'data'
  | 'storage'
  | 'connectors'
  | 'build'
  | 'functions'
  | 'live'
  // Older CLIs only.
  | 'prepare'
  | 'package'
  | 'upload'

export interface DeployStep {
  /** A known step, or `cli:<phase>` for a phase this file doesn't know. */
  id: DeployStepId | `cli:${string}`
  label: string
  state: 'done' | 'active' | 'todo'
}

/** What Ray talks about: the current step, or what's holding it up. */
export type DeployTopic = DeployStepId | 'signin' | 'retry' | 'other'

export interface DeployProgress {
  /** Done, then the active one, then those still to come. All done once live. */
  steps: DeployStep[]
  current: DeployStep
  /** The CLI's own words for what it's doing now, when they add something. */
  detail: string | null
  /** How far along, 0–1: where the current step starts, and where the next would. */
  at: number
  next: number
  /** The CLI's own percentage for the current step, when it gave one. */
  percent: number | null
  topic: DeployTopic
  live: boolean
  /** Rayfin 1.35+ progress lines, older output, or nothing telling yet. */
  reading: 'structured' | 'legacy' | 'pending'
}

export interface PhaseDef {
  id: DeployStepId
  label: string
  markers: string[]
}

/**
 * The steps of an older CLI's deploy (Rayfin 1.34 and earlier), each with loose
 * lowercase fragments of its `rayfin up` output that signal it has begun.
 *
 * Markers are broad and redundant (several synonyms each), so a wording change
 * degrades gracefully, and ordered so an *earlier* line never contains a *later*
 * step's marker. In particular "deploy" / "deploying" are never markers (they
 * appear from the very first line), and "workspace" / "item" aren't either (they
 * show up in the early Targeting block).
 */
export const LEGACY_PHASES: PhaseDef[] = [
  { id: 'connect', label: 'Connecting to Fabric', markers: [] },
  {
    id: 'prepare',
    label: 'Preparing deployment',
    markers: [
      'targeting',
      'workload endpoint',
      'publishable key',
      'runtime settings',
      'redeploy',
      'reusing',
      'deployment config',
      'wrote deployment',
      'database config'
    ]
  },
  {
    id: 'build',
    label: 'Building your app',
    markers: [
      'build command',
      'build:fabric',
      'tsc -b',
      'vite build',
      'building client',
      'transform',
      'modules transformed',
      'compiling',
      'esbuild',
      'webpack'
    ]
  },
  {
    id: 'package',
    label: 'Packaging assets',
    markers: [
      'rendering chunks',
      'gzip',
      'built in',
      'build command completed',
      'content packaged',
      'packaged (',
      'packaging',
      'bundling'
    ]
  },
  {
    id: 'upload',
    label: 'Uploading to Fabric',
    markers: [
      'content deployed',
      'deployed (',
      'uploading',
      'pushing',
      'hosting url',
      'deployment id',
      'static hosting'
    ]
  },
  {
    id: 'live',
    label: 'Going live',
    markers: [
      'is now deployed',
      'now deployed to fabric',
      'deployed to fabric!',
      'live at',
      'is live',
      'next steps',
      '🎉'
    ]
  }
]

/** Furthest older-CLI step whose markers appear anywhere in the (lowercased) log. */
function markerPhaseIdx(text: string): number {
  let reached = 0
  LEGACY_PHASES.forEach((p, i) => {
    if (p.markers.length && p.markers.some((m) => text.includes(m))) reached = i
  })
  return reached
}

/**
 * Time floor so an older CLI's step still advances through silent stretches.
 * Capped at Packaging: the clock alone never claims the app is uploaded or
 * live; those need a real marker.
 */
function timePhaseIdx(elapsedSec: number): number {
  if (elapsedSec >= 30) return 3
  if (elapsedSec >= 9) return 2
  if (elapsedSec >= 4) return 1
  return 0
}

/** An older CLI's step: the furthest of its markers and the time floor. */
export function legacyPhaseIndex(logText: string, elapsedSec: number): number {
  const text = logText.toLowerCase()
  return Math.min(
    LEGACY_PHASES.length - 1,
    Math.max(markerPhaseIdx(text), timePhaseIdx(elapsedSec))
  )
}

/** Rayfin's progress phases, and the step each belongs to. `null`: a moment within the current step. */
const PHASE_STEPS = new Map<string, DeployStepId | null>([
  ['license', 'connect'],
  ['capacity', 'capacity'],
  ['trial', 'capacity'],
  ['assignment', 'capacity'],
  ['workspace', 'workspace'],
  ['dependencies', null],
  ['posture', null],
  ['item', 'item'],
  ['target', 'item'],
  ['settings', 'settings'],
  ['data', 'data'],
  ['storage', 'storage'],
  ['persist', null],
  ['connectors', 'connectors'],
  ['static', 'build'],
  ['functions', 'functions']
])

const LABELS: Partial<Record<DeployStepId, string>> = {
  packages: 'Installing packages',
  connect: 'Connecting to Fabric',
  capacity: 'Getting Fabric capacity ready',
  workspace: 'Finding your workspace',
  item: 'Setting up your app in Fabric',
  settings: 'Applying settings',
  data: 'Updating your database',
  storage: 'Setting up file storage',
  connectors: 'Connecting your data sources',
  // Rayfin builds the app quietly and uploads it in the same step.
  build: 'Building and uploading your app',
  functions: 'Deploying your functions',
  live: 'Going live'
}

/** Where each step usually starts, as a share of the whole deploy. */
const STRUCTURED_AT: Partial<Record<DeployStepId, number>> = {
  packages: 0,
  connect: 0.03,
  capacity: 0.14,
  workspace: 0.22,
  item: 0.28,
  settings: 0.36,
  data: 0.42,
  storage: 0.48,
  connectors: 0.52,
  build: 0.56,
  functions: 0.88,
  live: 1
}

const LEGACY_AT: Partial<Record<DeployStepId, number>> = {
  packages: 0,
  connect: 0.03,
  prepare: 0.15,
  build: 0.35,
  package: 0.7,
  upload: 0.8,
  live: 1
}

/** The steps every deploy of a Fabricator app reaches, so the screen can show what's left. */
const EXPECTED: DeployStepId[] = ['connect', 'workspace', 'item', 'settings', 'build', 'live']

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
/** Fabricator's own first line of a deploy (commands/deploy.rs). A sign-in retry runs it again. */
const RUN_START = /^Deploying .+ to Fabric…$/
/** Fabricator installing a project's missing (or repairing its incomplete) packages before the CLI
 *  can run, or waiting for another install in the project to finish first. */
const PACKAGES = /^(?:Project dependencies are missing|Waiting for changes to this project's packages)/i
/** `[rayfin] <phase>: <message>`, sometimes ending in a percentage. */
const PROGRESS = /^\[rayfin\]\s+([a-z][\w-]*):\s*(.*?)\s*(?:\((\d{1,3})%\))?$/i
/** An older CLI's timed step, e.g. `[rayfin] TypeScript compilation successful... done (368ms)`. */
const TIMED = /\.\.\. (?:done|FAILED) \(/
const CLI_STARTED = /found rayfin project root|^\[rayfin/i
/** The CLI waiting for someone to sign in, in a browser or with a device code. */
const SIGN_IN = /launching login|browser login unavailable|devicelogin|enter the code/i
/** A CLI line about trying a request again, e.g. `⏳ Waiting 2s before retry... (1/5)`. */
const RETRY = /\bretry(?:ing)?\b.*\(\d+\/\d+\)/i

interface ProgressLine {
  phase: string
  message: string
  percent: number | null
}

function progressLine(line: string): ProgressLine | null {
  if (TIMED.test(line)) return null
  const m = PROGRESS.exec(line)
  if (!m) return null
  const percent = m[3] === undefined ? null : Math.min(100, Number(m[3]))
  return { phase: m[1].toLowerCase(), message: m[2], percent }
}

/** All the log's lines, trimmed, without blanks or terminal colours. */
function allLines(log: readonly string[]): string[] {
  return log
    .join('')
    .replace(ANSI, '')
    .split(/\r?\n|\r/)
    .map((line) => line.trim())
    .filter(Boolean)
}

/** How many times the deploy has started; a sign-in retry starts it again. */
export function deployRuns(log: readonly string[]): number {
  return allLines(log).filter((line) => RUN_START.test(line)).length
}

/** The lines of the latest run. */
function runLines(log: readonly string[]): string[] {
  const lines = allLines(log)
  let start = 0
  lines.forEach((line, i) => {
    if (RUN_START.test(line)) start = i
  })
  return lines.slice(start)
}

function tidy(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/[.…\s]+$/, '')
    .trim()
}

function capitalize(text: string, max: number): string {
  const capped = text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
  return capped.charAt(0).toUpperCase() + capped.slice(1)
}

/** A step this file doesn't know, in the CLI's own words. */
function unknownLabel(progress: ProgressLine): string {
  const words = tidy(progress.message) || progress.phase.replace(/[-_]+/g, ' ')
  return capitalize(words, 48)
}

/** Waiting on a sign-in: nothing but sign-in chatter since the CLI asked for one. */
function waitingForSignIn(lines: string[]): boolean {
  let asked = -1
  lines.forEach((line, i) => {
    if (SIGN_IN.test(line)) asked = i
  })
  return (
    asked >= 0 &&
    lines.slice(asked + 1).every((line) => SIGN_IN.test(line) || line.startsWith('[msal]'))
  )
}

/** The first position in `table` past `at`; 1 when there's none. */
function nextAt(table: Partial<Record<DeployStepId, number>>, at: number): number {
  const later = Object.values(table).filter((value): value is number => (value ?? 0) > at)
  return later.length ? Math.min(...later) : 1
}

/** After this long with nothing telling in the log, read it as an older CLI's. */
const LEGACY_AFTER_SEC = 20

/**
 * Read a deploy's log. `cliSec` is how long the CLI has been running in the
 * latest run (see {@link deployRuns}): only an older CLI's silent stretches
 * need it, and they don't include installing packages.
 */
export function readDeployProgress(log: readonly string[], cliSec: number): DeployProgress {
  const lines = runLines(log)
  const text = lines.join('\n').toLowerCase()
  const live = LEGACY_PHASES[LEGACY_PHASES.length - 1].markers.some((m) => text.includes(m))
  const signingIn = !live && waitingForSignIn(lines)
  const last = lines[lines.length - 1] ?? ''
  const retrying = !live && RETRY.test(last)

  // Fabricator installs missing packages before the CLI starts.
  const packagesAt = lines.findIndex((line) => PACKAGES.test(line))
  const installing =
    !live &&
    packagesAt >= 0 &&
    !lines.slice(packagesAt + 1).some((line) => CLI_STARTED.test(line) || SIGN_IN.test(line))
  const ids: Array<DeployStep['id']> = packagesAt >= 0 ? ['packages'] : []
  const labels = new Map<DeployStep['id'], string>()

  const progress = lines.map(progressLine).filter((p): p is ProgressLine => p !== null)
  const reading: DeployProgress['reading'] = progress.length
    ? 'structured'
    : markerPhaseIdx(text) > 0 || (!installing && !signingIn && cliSec >= LEGACY_AFTER_SEC)
      ? 'legacy'
      : 'pending'

  let currentId: DeployStep['id'] = installing ? 'packages' : 'connect'
  let detail: string | null = null
  let percent: number | null = null
  let upcoming: Array<DeployStep['id']>
  let at: number

  if (reading === 'legacy') {
    for (const phase of LEGACY_PHASES) {
      ids.push(phase.id)
      labels.set(phase.id, phase.label)
    }
    if (!installing) {
      currentId = LEGACY_PHASES[live ? LEGACY_PHASES.length - 1 : legacyPhaseIndex(text, cliSec)].id
    }
    upcoming = ids.splice(ids.indexOf(currentId) + 1)
    at = LEGACY_AT[currentId as DeployStepId] ?? 0
  } else {
    ids.push('connect')
    for (const p of progress) {
      const known = PHASE_STEPS.has(p.phase) ? PHASE_STEPS.get(p.phase) : undefined
      const id: DeployStep['id'] | null = known === null ? null : (known ?? `cli:${p.phase}`)
      if (id !== null && id !== currentId) {
        // Back to an earlier step: never move backwards.
        if (ids.includes(id)) continue
        ids.push(id)
        if (known === undefined) labels.set(id, unknownLabel(p))
        currentId = id
        percent = null
      }
      detail = p.message
      if (p.percent !== null) percent = p.percent
    }
    if (live && currentId !== 'live') {
      if (!ids.includes('live')) ids.push('live')
      currentId = 'live'
    }
    const reached = ids.slice(0, ids.indexOf(currentId) + 1)
    at = Math.max(0, ...reached.map((id) => STRUCTURED_AT[id as DeployStepId] ?? 0))
    // Still to come: the steps every deploy reaches that it hasn't reached yet.
    upcoming = EXPECTED.filter((id) => !ids.includes(id) && (STRUCTURED_AT[id] ?? 0) > at)
  }

  const label = (id: DeployStep['id']): string =>
    labels.get(id) ?? LABELS[id as DeployStepId] ?? capitalize(id.replace(/^cli:/, ''), 48)
  const currentIndex = ids.indexOf(currentId)
  const stateOf = (i: number): DeployStep['state'] =>
    live || i < currentIndex ? 'done' : i === currentIndex ? 'active' : 'todo'
  const steps: DeployStep[] = [
    ...ids.map((id, i): DeployStep => ({ id, label: label(id), state: stateOf(i) })),
    ...upcoming.map((id): DeployStep => ({ id, label: label(id), state: live ? 'done' : 'todo' }))
  ]
  const current = steps[currentIndex]

  const said = detail === null ? '' : capitalize(tidy(detail), 80)
  const sameAsLabel = said.toLowerCase() === current.label.toLowerCase()
  const topic: DeployTopic = live
    ? 'live'
    : signingIn
      ? 'signin'
      : retrying
        ? 'retry'
        : current.id.startsWith('cli:')
          ? 'other'
          : (current.id as DeployStepId)
  const next = nextAt(reading === 'legacy' ? LEGACY_AT : STRUCTURED_AT, at)

  return {
    steps,
    current,
    detail: live || !said || sameAsLabel || reading !== 'structured' ? null : said,
    at: live ? 1 : at,
    next: live ? 1 : next,
    percent: live ? null : percent,
    topic,
    live,
    reading
  }
}