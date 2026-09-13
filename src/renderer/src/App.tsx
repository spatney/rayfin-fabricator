import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSettings, AuthStatus, DoctorReport } from '@shared/ipc'
import SetupScreen from './screens/SetupScreen'
import Workbench from './screens/Workbench'
import UpdateBanner from './components/UpdateBanner'
import UpdateModal from './components/UpdateModal'
import ForcedUpdateScreen from './components/ForcedUpdateScreen'
import SplashScreen from './components/SplashScreen'
import { applyUiScale, watchTheme } from './theme'
import { useUpdates } from './update'
import { useToast } from './toast'
import { authErrorMessage } from './authErrors'

type Phase = 'loading' | 'setup' | 'ready'

// Keep the playful splash on screen long enough to actually be seen, even when the
// startup checks resolve almost instantly. Only the very first load is gated.
const SPLASH_MIN_MS = 2500
const SPLASH_MIN_MS_REDUCED = 700

function unavailableAuth(error: string): AuthStatus {
  return {
    copilot: { signedIn: false, error },
    rayfin: { signedIn: false, error },
    az: { signedIn: false, error }
  }
}

function App(): JSX.Element {
  const [phase, setPhase] = useState<Phase>('loading')
  const [doctor, setDoctor] = useState<DoctorReport | null>(null)
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  const mountedRef = useRef(false)
  const refreshSeqRef = useRef(0)
  const authSeqRef = useRef(0)
  const phaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toast = useToast()
  const { blocking } = useUpdates()

  // Don't leave the splash before its minimum showtime has elapsed (first load only).
  const gateUntilRef = useRef(
    Date.now() +
      (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        ? SPLASH_MIN_MS_REDUCED
        : SPLASH_MIN_MS)
  )
  const applyPhase = useCallback((next: Phase): void => {
    if (phaseTimerRef.current !== null) clearTimeout(phaseTimerRef.current)
    const wait = gateUntilRef.current - Date.now()
    if (wait <= 0) {
      setPhase(next)
    } else {
      phaseTimerRef.current = setTimeout(() => {
        phaseTimerRef.current = null
        if (mountedRef.current) setPhase(next)
      }, wait)
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    const seq = ++refreshSeqRef.current
    const authSeq = ++authSeqRef.current
    setRefreshing(true)
    setCheckError(null)
    setAuthError(null)
    const [d, a] = await Promise.allSettled([
      Promise.resolve().then(() => window.api.doctor.check()),
      Promise.resolve().then(() => window.api.auth.status())
    ])
    if (!mountedRef.current || seq !== refreshSeqRef.current) return
    if (d.status === 'fulfilled') {
      setDoctor(d.value)
    } else {
      setDoctor(null)
      setCheckError(authErrorMessage(d.reason, 'Could not check the installed tools. Please retry.'))
    }
    if (authSeq === authSeqRef.current) {
      if (a.status === 'fulfilled') {
        setAuth(a.value)
      } else {
        const error = authErrorMessage(a.reason, 'Could not verify sign-in. Please retry.')
        setAuth(unavailableAuth(error))
        setAuthError(error)
      }
    }
    // Startup and explicit sign-out return to setup; entering is always a choice.
    applyPhase('setup')
    setRefreshing(false)
  }, [applyPhase])

  const refreshAuth = useCallback(async (): Promise<void> => {
    const seq = ++authSeqRef.current
    try {
      const next = await window.api.auth.status()
      if (!mountedRef.current || seq !== authSeqRef.current) return
      setAuth(next)
      setAuthError(null)
    } catch (reason) {
      if (!mountedRef.current || seq !== authSeqRef.current) return
      const error = authErrorMessage(reason, 'Could not verify sign-in. Please retry.')
      // Keep the workbench (and its drafts) mounted, but never retain a stale
      // successful check after verification fails.
      setAuth(unavailableAuth(error))
      setAuthError(error)
      throw new Error(error)
    }
  }, [])

  // Explicit transition into the workbench, triggered by the setup screen's
  // "Enter" button once every prerequisite is satisfied.
  const enter = useCallback((): void => {
    if (refreshing || !doctor?.ready || !auth?.copilot.signedIn || !auth.az.signedIn) return
    ++refreshSeqRef.current
    if (phaseTimerRef.current !== null) {
      clearTimeout(phaseTimerRef.current)
      phaseTimerRef.current = null
    }
    setPhase('ready')
  }, [auth, doctor, refreshing])

  useEffect(() => {
    let alive = true
    mountedRef.current = true
    void refresh()
    void window.api.settings.get().then(
      (next) => {
        if (alive) setSettings(next)
      },
      (reason) => {
        if (alive) {
          toast.error(authErrorMessage(reason, 'Could not load app settings. Please retry.'), {
            title: 'Settings unavailable'
          })
        }
      }
    )
    return () => {
      alive = false
      mountedRef.current = false
      ++refreshSeqRef.current
      ++authSeqRef.current
      if (phaseTimerRef.current !== null) clearTimeout(phaseTimerRef.current)
    }
  }, [refresh, toast])

  // Apply the theme app-wide (covers splash + setup, not just the workbench)
  // and follow the OS when set to 'system'.
  useEffect(() => {
    if (!settings) return
    applyUiScale(settings.uiScale)
    return watchTheme(settings.theme)
  }, [settings])

  const updateSettings = useCallback(async (patch: Partial<AppSettings>): Promise<void> => {
    setSettings(await window.api.settings.set(patch))
  }, [])

  // A mandatory startup update blocks the entire app behind a forced-update screen
  // until it installs and restarts. Offline / up-to-date launches never set this.
  if (blocking) {
    return <ForcedUpdateScreen />
  }

  if (phase === 'loading') {
    return (
      <>
        <UpdateBanner />
        <UpdateModal />
        <SplashScreen />
      </>
    )
  }

  if (phase === 'ready' && auth) {
    return (
      <>
        <UpdateBanner />
        <UpdateModal />
        <Workbench
          auth={auth}
          onSignOut={refresh}
          onAuthChanged={refreshAuth}
          settings={settings}
          onSettingsChange={updateSettings}
        />
      </>
    )
  }

  return (
    <>
      <UpdateBanner />
      <UpdateModal />
      <SetupScreen
        doctor={doctor}
        auth={auth}
        error={[checkError, authError].filter(Boolean).join(' ') || undefined}
        refreshing={refreshing}
        onRefresh={refresh}
        onEnter={enter}
      />
    </>
  )
}

export default App
