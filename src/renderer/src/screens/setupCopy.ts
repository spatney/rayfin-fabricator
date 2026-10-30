// What the setup screen says, in the words of someone who isn't a developer.
//
// The people opening Fabricator for the first time are analysts and makers.
// "Command-line tools Fabricator needs locally" tells them nothing except that
// they might be in the wrong place. Every string here answers the question they
// are actually asking: what is this, and why do I need it?

/** One line saying what a tool is for, keyed by the doctor's tool id. */
const PURPOSE: Record<string, string> = {
  node: 'Runs your app on this computer while you build it',
  npm: 'Fetches the building blocks your app is made from',
  git: 'Keeps a history of your app so you can always go back',
  az: 'Lets Fabricator sign you in to Azure',
  gh: 'Lets Fabricator work with your code on GitHub'
}

/**
 * What a tool is for. Falls back to the backend's own hint, which is accurate
 * but written for developers, rather than inventing something.
 */
export function toolPurpose(id: string, fallback?: string | null): string {
  return PURPOSE[id] ?? fallback ?? 'Used by Fabricator behind the scenes'
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
  if (tool.satisfied) return tool.version ?? 'Ready'
  if (tool.found) {
    const target = tool.minVersion ? ` ${tool.minVersion} or newer` : ''
    return `Version ${tool.version ?? 'unknown'} — Fabricator needs${target || ' a newer version'}`
  }
  return toolPurpose(tool.id, tool.installHint)
}

/** How a tool's state reads as a single word. */
export function toolState(tool: { satisfied: boolean; found: boolean; required: boolean }): {
  word: string
  tone: 'ok' | 'warn' | 'bad' | 'muted'
} {
  if (tool.satisfied) return { word: 'Ready', tone: 'ok' }
  if (tool.found) return { word: 'Needs updating', tone: 'warn' }
  if (!tool.required) return { word: 'Optional', tone: 'muted' }
  return { word: 'Missing', tone: 'bad' }
}

/** The headline above the checklist, which doubles as the progress summary. */
export function progressLine(done: number, total: number, checking: boolean): string {
  if (checking) return 'Checking what you already have…'
  if (total > 0 && done === total) return "Everything's ready. You can start building."
  const left = total - done
  if (done === 0) return "Let's get Fabricator set up. This usually takes a minute."
  return `${left} ${left === 1 ? 'thing' : 'things'} left to set up.`
}
