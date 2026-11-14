// Turning a failed install or sign-in into something a non-developer can act on.
//
// When an install fails, Fabricator currently shows whatever the package
// manager said — "0x8A150044", "ERROR: Another installation is already in
// progress". For the people this app is for, that is indistinguishable from
// "it's broken and I can't use this". Each pattern below names the cause in
// plain language and says what to do next; the raw text is kept so it can be
// shown on request and so nothing is lost from a bug report.

import { translator } from '../i18n'

export interface SetupProblem {
  /** What went wrong, in one plain sentence. */
  title: string
  /** What to do about it. */
  fix: string
  /** True when retrying is likely to work, so the UI can offer it first. */
  retryable: boolean
}

/**
 * Ordered: the first pattern that matches wins, so put specific ones first.
 * The patterns match English output from the package managers and CLIs, so
 * they stay English; only what is shown to the user is translated.
 */
const PATTERNS: Array<{ test: RegExp; problem: (raw: string) => SetupProblem }> = [
  {
    // Windows package manager, one install at a time.
    test: /another installation|already in progress|0x8a150044|being used by another/i,
    problem: () => {
      const t = translator('setup')
      return {
        title: t('problems.busy.title'),
        fix: t('problems.busy.fix'),
        retryable: true
      }
    }
  },
  {
    test: /elevat|administrator|run as admin|requires admin|0x80070005|access is denied|EPERM|EACCES/i,
    problem: () => {
      const t = translator('setup')
      return {
        title: t('problems.permission.title'),
        fix: t('problems.permission.fix'),
        retryable: true
      }
    }
  },
  {
    test: /ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|getaddrinfo|network|offline|could not resolve|temporary failure in name resolution|unable to connect/i,
    problem: () => {
      const t = translator('setup')
      return {
        title: t('problems.offline.title'),
        fix: t('problems.offline.fix'),
        retryable: true
      }
    }
  },
  {
    test: /no space|ENOSPC|disk full|not enough space/i,
    problem: () => {
      const t = translator('setup')
      return {
        title: t('problems.diskFull.title'),
        fix: t('problems.diskFull.fix'),
        retryable: true
      }
    }
  },
  {
    test: /winget.*(not recognized|not found|cannot find)|'winget'/i,
    problem: () => {
      const t = translator('setup')
      return {
        title: t('problems.noWinget.title'),
        fix: t('problems.noWinget.fix'),
        retryable: false
      }
    }
  },
  {
    test: /brew.*(not found|command not found)|'brew'/i,
    problem: () => {
      const t = translator('setup')
      return {
        title: t('problems.noHomebrew.title'),
        fix: t('problems.noHomebrew.fix'),
        retryable: false
      }
    }
  },
  {
    test: /cancel|abort|user declined|operation was canceled/i,
    problem: () => {
      const t = translator('setup')
      return {
        title: t('problems.cancelled.title'),
        fix: t('problems.cancelled.fix'),
        retryable: true
      }
    }
  },
  {
    test: /saml|single sign-?on|sso|organization has enabled/i,
    problem: () => {
      const t = translator('setup')
      return {
        title: t('problems.sso.title'),
        fix: t('problems.sso.fix'),
        retryable: true
      }
    }
  },
  {
    test: /no (active )?copilot|not entitled|subscription|quota|free tier/i,
    problem: () => {
      const t = translator('setup')
      return {
        title: t('problems.noCopilot.title'),
        fix: t('problems.noCopilot.fix'),
        retryable: true
      }
    }
  },
  {
    test: /not recognized|command not found|is not a recognized/i,
    problem: () => {
      const t = translator('setup')
      return {
        title: t('problems.notOnPath.title'),
        fix: t('problems.notOnPath.fix'),
        retryable: true
      }
    }
  }
]

/**
 * Translate a raw error into something actionable. Returns `null` when nothing
 * is recognised, so the caller shows the original text rather than a vague
 * reassurance that hides what happened.
 */
export function explainSetupError(raw: string | undefined | null): SetupProblem | null {
  const text = (raw ?? '').trim()
  if (!text) return null
  for (const { test, problem } of PATTERNS) {
    if (test.test(text)) return problem(text)
  }
  return null
}

/**
 * The problem to show for a failed step, falling back to the raw text when it
 * isn't recognised. Never invents a cause it doesn't have evidence for.
 */
export function setupProblem(raw: string | undefined | null): SetupProblem | null {
  const known = explainSetupError(raw)
  if (known) return known
  const text = (raw ?? '').trim()
  if (!text) return null
  return {
    title: text,
    fix: translator('setup')('problems.unknownFix'),
    retryable: true
  }
}

/**
 * Whether installing anything can work right now. The browser's own offline
 * flag is the one signal available without making a request, and every install
 * downloads something.
 */
export function canInstall(online: boolean = navigator.onLine): boolean {
  return online
}
