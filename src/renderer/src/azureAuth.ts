import { useCallback, useEffect, useRef, useState } from 'react'
import { authErrorMessage } from './authErrors'

/** An Azure sign-in asked for by the feature that needs it. */
export interface AzureSignIn {
  /** The sign-in is running: the browser is open. */
  signingIn: boolean
  /** Why the last attempt didn't finish. */
  error: string | null
  /** Sign in to Azure, then carry on. Resolves whether it worked. */
  signIn: () => Promise<boolean>
}

const FAILED = 'Azure sign-in did not complete. Please try again.'

/**
 * Sign in to Azure on demand. Azure is optional at setup, so each feature that
 * reads with the Azure CLI's sign-in asks for it when it's missing. Once the
 * sign-in is verified, `onSignedIn` carries on: refresh the app's accounts and
 * retry what needed it. A rejection from it counts as a failed sign-in.
 */
export function useAzureSignIn(onSignedIn: () => Promise<void> | void): AzureSignIn {
  const [signingIn, setSigningIn] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const running = useRef(false)
  const mounted = useRef(true)
  const carryOn = useRef(onSignedIn)
  carryOn.current = onSignedIn

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const signIn = useCallback(async (): Promise<boolean> => {
    if (running.current) return false
    running.current = true
    setSigningIn(true)
    setError(null)
    try {
      const result = await window.api.auth.loginAz()
      if (!result.ok) throw new Error(authErrorMessage(result.error, FAILED))
      if (mounted.current) await carryOn.current()
      return true
    } catch (reason) {
      if (mounted.current) setError(authErrorMessage(reason, FAILED))
      return false
    } finally {
      running.current = false
      if (mounted.current) setSigningIn(false)
    }
  }, [])

  return { signingIn, error, signIn }
}
