import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSettings, AuthStatus, DoctorReport } from '@shared/ipc'
import SetupScreen from './screens/SetupScreen'
import Workbench from './screens/Workbench'
import UpdateBanner from './components/UpdateBanner'
import SplashScreen from './components/SplashScreen'
import { watchTheme } from './theme'

type Phase = 'loading' | 'setup' | 'ready'

// Keep the playful splash on screen long enough to actually be seen, even when the
// startup checks resolve almost instantly. Only the very first load is gated.
const SPLASH_MIN_MS = 2500
const SPLASH_MIN_MS_REDUCED = 700

function App(): JSX.Element {
  const [phase, setPhase] = useState<Phase>('loading')
  const [doctor, setDoctor] = useState<DoctorReport | null>(null)
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  // Don't leave the splash before its minimum showtime has elapsed (first load only).
  const gateUntilRef = useRef(
    Date.now() +
      (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        ? SPLASH_MIN_MS_REDUCED
        : SPLASH_MIN_MS)
  )
  const applyPhase = useCallback((next: Phase): void => {
    const wait = gateUntilRef.current - Date.now()
    if (wait <= 0) {
      setPhase(next)
    } else {
      setTimeout(() => setPhase(next), wait)
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    setRefreshing(true)
    try {
      const [d, a] = await Promise.all([window.api.doctor.check(), window.api.auth.status()])
      setDoctor(d)
      setAuth(a)
      // Always land on the setup screen — even when every tool is installed and
      // all accounts are signed in. Entering the workbench is an explicit choice
      // the user makes from there (see `enter`), so re-checks and sign-outs keep
      // us on setup rather than auto-advancing.
      applyPhase('setup')
    } finally {
      setRefreshing(false)
    }
  }, [applyPhase])

  // Explicit transition into the workbench, triggered by the setup screen's
  // "Enter" button once every prerequisite is satisfied.
  const enter = useCallback((): void => {
    setPhase('ready')
  }, [])

  useEffect(() => {
    void refresh()
    void window.api.settings.get().then(setSettings)
  }, [refresh])

  // Apply the theme app-wide (covers splash + setup, not just the workbench)
  // and follow the OS when set to 'system'.
  useEffect(() => {
    if (!settings) return
    return watchTheme(settings.theme)
  }, [settings])

  const updateSettings = useCallback(async (patch: Partial<AppSettings>): Promise<void> => {
    setSettings(await window.api.settings.set(patch))
  }, [])

  if (phase === 'loading') {
    return (
      <>
        <UpdateBanner />
        <SplashScreen />
      </>
    )
  }

  if (phase === 'ready' && auth) {
    return (
      <>
        <UpdateBanner />
        <Workbench
          auth={auth}
          onSignOut={refresh}
          settings={settings}
          onSettingsChange={updateSettings}
        />
      </>
    )
  }

  return (
    <>
      <UpdateBanner />
      <SetupScreen doctor={doctor} auth={auth} refreshing={refreshing} onRefresh={refresh} onEnter={enter} />
    </>
  )
}

export default App
