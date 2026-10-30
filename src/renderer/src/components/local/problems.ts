import type { LocalProblem, LocalStatus } from '@shared/ipc'

/** What Help is asked when the local preview's **Find out why** opens it. */
export const LOCAL_QUESTION = 'Why didn’t my app start on this computer?'

export interface ProblemText {
  title: string
  message: string
  hint: string | null
}

const COULDNT_START = 'Your app couldn’t start on this computer'

/**
 * A problem the way the preview tells it. rayfin-local's own message and hint
 * speak to its command line (flags, `npm install` in a folder), so the problems
 * the preview has a button for are told in Fabricator's words.
 */
export function describeProblem(problem: LocalProblem | null): ProblemText {
  if (!problem) {
    return { title: COULDNT_START, message: 'Its local backend stopped.', hint: null }
  }
  const details = problem.details ?? {}
  switch (problem.code) {
    case 'schema-refused':
      return {
        title: 'This change would delete local data',
        message:
          'The data model changed in a way that deletes data stored on this computer, so your app waits for you to decide.',
        hint: null
      }
    case 'packages-missing':
      return {
        title: 'Your app’s packages aren’t installed',
        message: problem.message,
        hint: 'Install them, and Fabricator starts your app again.'
      }
    case 'node-missing':
      return {
        title: 'Node.js isn’t installed',
        message: 'Your app runs on Node.js, and Fabricator couldn’t find it on this computer.',
        hint: 'Set it up, then try again.'
      }
    case 'node-too-old':
      return {
        title: 'Node.js needs an update',
        message:
          typeof details.version === 'string' && details.version
            ? `Your app needs Node.js 20 or later, and this computer has ${details.version}.`
            : 'Your app needs Node.js 20 or later.',
        hint: 'Update it, then try again.'
      }
    case 'already-serving':
      return {
        title: 'This app is already running',
        message:
          typeof details.pid === 'number'
            ? `Another program runs this app on this computer (process ${details.pid}), such as rayfin-local in a terminal.`
            : 'Another program runs this app on this computer, such as rayfin-local in a terminal.',
        hint: 'Stop it, and Fabricator runs your app here.'
      }
    case 'crashed':
      return { title: 'Your app keeps stopping', message: problem.message, hint: problem.hint }
    default:
      return { title: COULDNT_START, message: problem.message, hint: problem.hint }
  }
}

/** What a starting or restarting backend is doing, for the preview's placeholder. */
export function startingDetail(status: LocalStatus | null): string {
  if (status?.state === 'restarting' && status.error?.code === 'exited') {
    return 'It stopped unexpectedly, so Fabricator is starting it again.'
  }
  switch (status?.phase) {
    case 'analysis':
      return 'Reading your app’s data model'
    case 'schema':
      return 'Updating its database'
    case 'functions':
      return 'Building its functions'
    case 'vite':
      return 'Starting its dev server'
    default:
      return status?.state === 'restarting'
        ? 'Starting it again on this computer'
        : 'Getting it ready on this computer'
  }
}
