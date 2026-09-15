import type { ProcResult } from '@shared/ipc'
import { invalidateCopilotModels } from './copilotModels'

export async function signInToCopilot(): Promise<ProcResult> {
  const result = await window.api.auth.loginCopilot()
  if (result.ok) invalidateCopilotModels()
  return result
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
