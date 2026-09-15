import { describe, expect, it } from 'vitest'
import { isCopilotAuthError } from './copilotAuth'

describe('Copilot authentication errors', () => {
  it.each([
    'Not logged in',
    'GitHub Copilot is not signed in.',
    'Not authenticated',
    'Execution failed: Error: Session was not created with authentication info or custom provider',
    'Authentication failed',
    '401: Unauthorized',
    'Bad credentials',
    'Token has expired',
    'Invalid authentication token'
  ])('recognizes %s', (message) => {
    expect(isCopilotAuthError(message)).toBe(true)
  })

  it.each([undefined, 'Session not found abc', 'Rate limit exceeded', 'Network timeout', 'File not found'])(
    'does not mistake %s for a sign-in failure',
    (message) => expect(isCopilotAuthError(message)).toBe(false)
  )
})
