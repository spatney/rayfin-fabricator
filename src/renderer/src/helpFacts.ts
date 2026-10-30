/**
 * What is true *right now*, written as short sentences the Help assistant can
 * read before it answers.
 *
 * The activity journal is a history: it says what happened, in order. On its
 * own that is a trap — a failure from twenty minutes ago reads exactly like a
 * failure from twenty seconds ago, so an assistant working only from the
 * journal will report problems the user already fixed. (It did exactly that:
 * asked "how did setup go?" on a fully green setup screen, it listed three
 * errors that had already been resolved.)
 *
 * These facts are the other half. The journal says what happened; these say
 * where things stand. Together they let the assistant say "that failed earlier
 * but it's working now" instead of raising an alarm.
 *
 * Rules for anything added here:
 *
 *   * state, not events — "Git is not installed", never "installing Git failed";
 *   * one short sentence each, in plain language the user would recognise;
 *   * only what the user can see for themselves in the UI, so the assistant
 *     never appears to know something private.
 */
import type { AuthStatus, DoctorReport, LocalStatus, StudioProject } from '@shared/ipc'
import { describeProblem } from './components/local/problems'
import { localStateLabel, refusedSchemaLosses } from './localBackend'
import { visibleTools } from './localDevelopment'
import { setupReady } from './startup'

/** Join a list the way a person would: "a, b and c". */
function sentenceList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/**
 * The state of setup: tools, accounts, and whether the user can get in.
 *
 * Used on the setup screen, where all of it is on screen in front of the user.
 * The local backend's check shows there only with Local development on.
 */
export function setupFacts(
  doctor: DoctorReport | null,
  auth: AuthStatus | null,
  options: { online?: boolean; localDevelopment?: boolean } = {}
): string[] {
  const facts: string[] = []
  const localDevelopment = Boolean(options.localDevelopment)

  if (options.online === false) {
    // Worth saying first: it explains most of what follows.
    facts.push('This computer is currently offline.')
  }

  if (!doctor) {
    facts.push('The tool check has not finished running yet.')
  } else {
    const tools = visibleTools(doctor.tools, localDevelopment)
    const required = tools.filter((t) => t.required)
    const missing = required.filter((t) => !t.satisfied)
    if (missing.length === 0 && required.length > 0) {
      facts.push(
        `All ${required.length} required tools are installed and working: ${sentenceList(
          required.map((t) => (t.version ? `${t.name} ${t.version}` : t.name))
        )}.`
      )
    } else {
      for (const tool of missing) {
        facts.push(
          tool.checkError
            ? `${tool.name} is installed but its version check is failing.`
            : `${tool.name} is not installed yet.`
        )
      }
      const ready = required.filter((t) => t.satisfied)
      if (ready.length > 0) {
        facts.push(`Installed and working: ${sentenceList(ready.map((t) => t.name))}.`)
      }
    }
    // Optional tools only matter when they're present; absence isn't a problem.
    const optional = tools.filter((t) => !t.required && t.satisfied)
    if (optional.length > 0) {
      facts.push(`Also installed (optional): ${sentenceList(optional.map((t) => t.name))}.`)
    }
  }

  facts.push(...accountFacts(auth, { localDevelopment }))

  // The same test the setup screen uses: Azure is optional, so it isn't part of it.
  facts.push(
    setupReady(doctor, auth)
      ? 'Setup is complete: the required tools work and GitHub Copilot is signed in, so the user can enter Fabricator.'
      : 'Setup is not finished yet; at least one required step on the setup screen still needs attention.'
  )

  return facts
}

/**
 * Which accounts are connected. Separate from {@link setupFacts} because the
 * workbench knows the accounts but has no tool report of its own — and claiming
 * "the tool check has not finished" to someone who is already inside the app
 * would be worse than saying nothing.
 *
 * Only GitHub Copilot is required. Azure is optional: the features that need
 * it ask for a sign-in when they're used. So is Microsoft Fabric with Local
 * development on, when apps build and run on this computer; without it, apps
 * are developed against their published copy, so publishing needs it.
 */
export function accountFacts(
  auth: AuthStatus | null,
  options: { localDevelopment?: boolean } = {}
): string[] {
  const facts: string[] = []
  const localDevelopment = Boolean(options.localDevelopment)

  const copilot = auth?.copilot
  if (copilot?.signedIn) {
    facts.push(
      copilot.user
        ? `Signed in to GitHub Copilot as ${copilot.user}.`
        : 'Signed in to GitHub Copilot.'
    )
  } else if (copilot?.checking) {
    facts.push('The GitHub Copilot account is still being checked.')
  } else {
    facts.push('Not signed in to GitHub Copilot.')
  }

  const fabric = auth?.rayfin
  if (fabric?.signedIn) {
    facts.push(
      fabric.user
        ? `Signed in to Microsoft Fabric as ${fabric.user}.`
        : 'Signed in to Microsoft Fabric.'
    )
  } else if (fabric?.checking) {
    facts.push('The Microsoft Fabric account is still being checked.')
  } else {
    facts.push(
      localDevelopment
        ? 'Not signed in to Microsoft Fabric. That is optional: it is only needed to publish apps, and publishing asks for it.'
        : 'Not signed in to Microsoft Fabric. It is needed to publish apps, and publishing asks for it.'
    )
  }

  const az = auth?.az
  if (az?.signedIn) {
    facts.push(az.user ? `Signed in to Azure as ${az.user}.` : 'Signed in to Azure.')
  } else if (az?.checking) {
    facts.push('The Azure account is still being checked.')
  } else {
    facts.push(
      localDevelopment
        ? 'Not signed in to Azure. That is optional: apps build and run on this computer without it, and sharing an app, adding Fabric data, migrating Power BI reports and connectors ask for it when they are used.'
        : 'Not signed in to Azure. That is optional: sharing an app, adding Fabric data, migrating Power BI reports and connectors ask for it when they are used.'
    )
  }

  return facts
}

/** What the preview shows of the open personal app (see {@link workbenchFacts}). */
export interface LocalPreviewFacts {
  /**
   * The app's local backend, as the preview shows it; `null` while its status
   * isn't known yet.
   */
  local?: LocalStatus | null
  /** Which copy of a published app the preview shows: this computer's, or the published one. */
  view?: 'local' | 'published'
  /**
   * The preview uses the published app's backend because the local backend
   * can't run the app, and says why in these words.
   */
  fallbackReason?: string | null
}

/**
 * The open personal app on this computer, as the preview tells it: which copy
 * it shows, whether the app runs and, when it doesn't, what the preview says
 * about it. The local backend's details (its output, the exact problem) come
 * to Help from Fabricator itself.
 */
function localFacts(active: StudioProject, options: LocalPreviewFacts): string[] {
  const facts: string[] = []
  const name = `"${active.name}"`

  if (options.fallbackReason) {
    facts.push(
      `The preview of ${name} uses its published app's backend, not this computer's, and says: "${options.fallbackReason}"`
    )
    return facts
  }

  if (active.lastDeploy?.url && options.view === 'published') {
    facts.push(
      `The preview shows the published copy of ${name} (Published), with its own data, not the copy on this computer.`
    )
  } else if (active.lastDeploy?.url && options.view === 'local') {
    facts.push(
      `The preview shows the copy of ${name} on this computer (Local), with its local data, not the published one.`
    )
  }

  const local = options.local
  if (!local) return facts
  const status = `the preview's status says "${localStateLabel(local)}"`
  switch (local.state) {
    case 'running':
      facts.push(`${name} is running on this computer; ${status}.`)
      if (refusedSchemaLosses(local)) {
        facts.push(
          `A change to the data model of ${name} would delete local data, so it waits for the user to decide; until then the previous data model stays in use.`
        )
      }
      break
    case 'starting':
    case 'restarting':
      facts.push(`${name} is starting on this computer; ${status}.`)
      break
    case 'error':
      facts.push(
        `${name} is not running on this computer because of a problem: the preview says "${describeProblem(local.error).title}", and ${status}.`
      )
      break
    default:
      facts.push(`${name} is not running on this computer; ${status}.`)
  }
  return facts
}

/** State of the app the user is actually looking at. */
export function workbenchFacts(
  active: StudioProject | null,
  options: {
    projectCount?: number
    team?: boolean
    onHome?: boolean
    previewUrl?: string | null
    /** The open app is being published right now. */
    deploying?: boolean
    /** The most recent publish failed, and none has run since. */
    deployFailed?: boolean
    /**
     * The Local development experiment is on: personal apps run on this
     * computer, on their local backend. Off, they're developed against their
     * published copy, and a new one is published before chat unlocks.
     */
    localDevelopment?: boolean
  } & LocalPreviewFacts = {}
): string[] {
  const facts: string[] = []

  if (!active) {
    facts.push(
      options.projectCount
        ? `No app is open right now; the user is looking at their list of ${options.projectCount} app(s).`
        : 'No app is open, and none have been created on this computer yet.'
    )
    return facts
  }

  if (options.onHome) {
    facts.push('The user is looking at their list of apps, not working inside one.')
  }

  facts.push(
    options.team
      ? `The open app is "${active.name}", which lives in a team workspace.`
      : `The open app is "${active.name}", which is a personal app on this computer.`
  )

  if (active.lastDeploy?.url) {
    const where = active.workspaceName ?? active.workspace
    facts.push(
      where
        ? `"${active.name}" has been published to the ${where} workspace.`
        : `"${active.name}" has been published.`
    )
  } else if (options.team) {
    facts.push(
      `No publish of "${active.name}" is recorded on this computer; the team's pipeline publishes it.`
    )
  } else if (options.localDevelopment) {
    facts.push(
      `"${active.name}" has never been published, which is fine: it runs on this computer, and publishing is optional.`
    )
  } else if (active.awaitingFirstDeploy) {
    facts.push(
      `"${active.name}" has never been published, so chat stays locked until its first publish.`
    )
  } else {
    facts.push(`No publish of "${active.name}" is recorded on this computer.`)
  }

  if (options.deploying) facts.push(`"${active.name}" is being published right now.`)
  else if (options.deployFailed) {
    // State, not the event: the journal has the failure itself, and this says
    // it is still the latest word rather than something a later publish fixed.
    facts.push(
      `The most recent publish of "${active.name}" failed, and the notice above the preview says so. No publish has run since.`
    )
  }
  // Only personal apps with Local development have a local backend.
  if (!options.team && options.localDevelopment) facts.push(...localFacts(active, options))
  if (options.previewUrl) facts.push(`A local preview of "${active.name}" is running.`)

  return facts
}
