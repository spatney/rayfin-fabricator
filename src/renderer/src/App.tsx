import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSettings, AuthStatus, DoctorReport } from '@shared/ipc'
import Workbench from './screens/Workbench'
import UpdateBanner from './components/UpdateBanner'
import ForcedUpdateScreen from './components/ForcedUpdateScreen'
import SplashScreen from './components/SplashScreen'
import { applyUiScale, watchTheme } from './theme'
import { useUpdates } from './update'

type Phase = 'loading' | 'ready'

// Keep the playful splash on screen long enough to actually be seen, even when the
// startup checks resolve almost instantly. Only the very first load is gated.
const SPLASH_MIN_MS = 2500
const SPLASH_MIN_MS_REDUCED = 700

function App(): JSX.Element {
  const [phase, setPhase] = useState<Phase>('loading')
  const [doctor, setDoctor] = useState<DoctorReport | null>(null)
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const { blocking } = useUpdates()

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
    const [d, a] = await Promise.all([window.api.doctor.check(), window.api.auth.status()])
    setDoctor(d)
    setAuth(a)
    // Land directly in the workbench — the environment check (tools + sign-in) now
    // lives in Settings → Environment, surfaced by a non-blocking banner when
    // something still needs attention. `doctor` is kept only to drive that banner.
    applyPhase('ready')
  }, [applyPhase])

  const refreshAuth = useCallback(async (): Promise<void> => {
    setAuth(await window.api.auth.status())
  }, [])

  useEffect(() => {
    void refresh()
    void window.api.settings.get().then(setSettings)
  }, [refresh])

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
          doctor={doctor}
          onSignOut={refresh}
          onAuthChanged={refreshAuth}
          settings={settings}
          onSettingsChange={updateSettings}
        />
      </>
    )
  }

  // Auth failed to resolve (rare): keep the splash rather than a dead setup gate.
  return (
    <>
      <UpdateBanner />
      <SplashScreen />
    </>
  )
}

export default App
