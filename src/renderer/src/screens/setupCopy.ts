// What the setup screen says, in the words of someone who isn't a developer.
//
// The people opening Fabricator for the first time are analysts and makers.
// "Command-line tools Fabricator needs locally" tells them nothing except that
// they might be in the wrong place. Every string here answers the question they
// are actually asking: what is this, and why do I need it?

import { translator } from '../i18n'

/** One line saying what a tool is for, keyed by the doctor's tool id. */
function purpose(id: string): string | undefined {
  const t = translator('setup')
  switch (id) {
    case 'node':
      return t('tools.purpose.node')
    case 'npm':
      return t('tools.purpose.npm')
    case 'git':
      return t('tools.purpose.git')
    case 'az':
      return t('tools.purpose.az')
    case 'gh':
      return t('tools.purpose.gh')
    default:
      return undefined
  }
}

/**
 * What a tool is for. Falls back to the backend's own hint, which is accurate
 * but written for developers, rather than inventing something.
 */
export function toolPurpose(id: string, fallback?: string | null): string {
  return purpose(id) ?? fallback ?? translator('setup')('tools.purpose.fallback')
}

/**
 * The line under a tool's name. A working tool shows its version and nothing
 * else — the user doesn't need to be sold something they already have. A tool
 * that needs attention explains itself.
 */
export function toolLine(tool: {
  id: string
  version?: string | null
  satisfied: boolean
  found: boolean
  minVersion?: string | null
  installHint?: string | null
  required: boolean
}): string {
  const t = translator('setup')
  if (tool.satisfied) return tool.version ?? t('tools.state.ready')
  if (tool.found) {
    const { version, minVersion: min } = tool
    if (version === null || version === undefined) {
      return min ? t('tools.unknownVersionNeedsMin', { min }) : t('tools.unknownVersionNeedsNewer')
    }
    return min
      ? t('tools.versionNeedsMin', { version, min })
      : t('tools.versionNeedsNewer', { version })
  }
  return toolPurpose(tool.id, tool.installHint)
}

/** How a tool's state reads as a single word. */
export function toolState(tool: { satisfied: boolean; found: boolean; required: boolean }): {
  word: string
  tone: 'ok' | 'warn' | 'bad' | 'muted'
} {
  const t = translator('setup')
  if (tool.satisfied) return { word: t('tools.state.ready'), tone: 'ok' }
  if (tool.found) return { word: t('tools.state.needsUpdating'), tone: 'warn' }
  if (!tool.required) return { word: t('tools.state.optional'), tone: 'muted' }
  return { word: t('tools.state.missing'), tone: 'bad' }
}

/** The headline above the checklist, which doubles as the progress summary. */
export function progressLine(done: number, total: number, checking: boolean): string {
  const t = translator('setup')
  if (checking) return t('progress.checking')
  if (total > 0 && done === total) return t('progress.ready')
  const left = total - done
  if (done === 0) return t('progress.start')
  return t('progress.left', { count: left })
}
