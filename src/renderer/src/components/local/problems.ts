import type { LocalProblem, LocalStatus } from '@shared/ipc'
import { translator } from '../../i18n'

/** What Help is asked when the local preview's **Find out why** opens it. */
export const LOCAL_QUESTION = 'Why didn’t my app start on this computer?'

export interface ProblemText {
  title: string
  message: string
  hint: string | null
}

/**
 * A problem the way the preview tells it. rayfin-local's own message and hint
 * speak to its command line (flags, `npm install` in a folder), so the problems
 * the preview has a button for are told in Fabricator's words.
 */
export function describeProblem(problem: LocalProblem | null): ProblemText {
  const t = translator('preview')
  if (!problem) {
    return { title: t('problem.couldntStart'), message: t('problem.stopped'), hint: null }
  }
  const details = problem.details ?? {}
  switch (problem.code) {
    case 'schema-refused':
      return {
        title: t('problem.schemaRefused.title'),
        message: t('problem.schemaRefused.message'),
        hint: null
      }
    case 'packages-missing':
      return {
        title: t('problem.packagesMissing.title'),
        message: problem.message,
        hint: t('problem.packagesMissing.hint')
      }
    case 'node-missing':
      return {
        title: t('problem.nodeMissing.title'),
        message: t('problem.nodeMissing.message'),
        hint: t('problem.nodeMissing.hint')
      }
    case 'node-too-old':
      return {
        title: t('problem.nodeTooOld.title'),
        message:
          typeof details.version === 'string' && details.version
            ? t('problem.nodeTooOld.messageVersion', { version: details.version })
            : t('problem.nodeTooOld.message'),
        hint: t('problem.nodeTooOld.hint')
      }
    case 'already-serving':
      return {
        title: t('problem.alreadyServing.title'),
        message:
          typeof details.pid === 'number'
            ? t('problem.alreadyServing.messagePid', { pid: details.pid })
            : t('problem.alreadyServing.message'),
        hint: t('problem.alreadyServing.hint')
      }
    case 'crashed':
      return { title: t('problem.crashed'), message: problem.message, hint: problem.hint }
    default:
      return { title: t('problem.couldntStart'), message: problem.message, hint: problem.hint }
  }
}

/** What a starting or restarting backend is doing, for the preview's placeholder. */
export function startingDetail(status: LocalStatus | null): string {
  const t = translator('preview')
  if (status?.state === 'restarting' && status.error?.code === 'exited') {
    return t('starting.restarted')
  }
  switch (status?.phase) {
    case 'analysis':
      return t('starting.analysis')
    case 'schema':
      return t('starting.schema')
    case 'functions':
      return t('starting.functions')
    case 'vite':
      return t('starting.vite')
    default:
      return status?.state === 'restarting' ? t('starting.restarting') : t('starting.starting')
  }
}
