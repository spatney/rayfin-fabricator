import type { ProcResult } from '@shared/ipc'
import { invalidateCopilotModels } from './copilotModels'

const HOST_KEY = 'fabricator.copilotHost'

export function getCopilotHost(): string {
  try {
    return localStorage.getItem(HOST_KEY) ?? 'github.com'
  } catch (error) {
    console.warn('Could not read the saved Copilot host', error)
    return 'github.com'
  }
}

export async function signInToCopilot(host?: string): Promise<ProcResult> {
  try {
    const result = await window.api.auth.loginCopilot(host)
    if (result.ok && host) {
      try {
        localStorage.setItem(HOST_KEY, host.trim())
      } catch (error) {
        console.warn('Could not save the Copilot host', error)
      }
    }
    return result
  } finally {
    // Credentials may change even when the final verification fails.
    invalidateCopilotModels()
  }
}

export async function signOutOfCopilot(): Promise<ProcResult> {
  try {
    return await window.api.auth.logoutCopilot()
  } finally {
    invalidateCopilotModels()
  }
}

/** Only inspect engine errors, never assistant prose or individual tool output. */
export function isCopilotAuthError(error: string | undefined): boolean {
  return Boolean(
    error &&
      /\bnot (?:logged|signed) in\b|\bnot authenticated\b|\bsession was not created with authentication info\b|\b(?:authentication|authorization) (?:is )?(?:required|failed)\b|\b(?:invalid|expired|revoked) (?:access |authentication |auth )?(?:token|credentials?)\b|\b(?:token|credentials?) (?:has |have |is |are )?(?:expired|invalid|revoked)\b|\bunauthorized\b|\bbad credentials\b|\b401\b/i.test(
        error
      )
  )
}
