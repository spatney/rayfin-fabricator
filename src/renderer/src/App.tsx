import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppSettings, AuthProvider, AuthStatus, DoctorReport } from '@shared/ipc'
import SetupScreen from './screens/SetupScreen'
import Workbench from './screens/Workbench'
import UpdateBanner from './components/UpdateBanner'
import UpdateModal from './components/UpdateModal'
import ForcedUpdateScreen from './components/ForcedUpdateScreen'
import SplashScreen from './components/SplashScreen'
import { MascotProvider } from './components/mascot/stage'
import { applyUiScale, watchTheme } from './theme'
import { useUpdates } from './update'
import { useToast } from './toast'
import { authErrorMessage } from './authErrors'
import { reportEvent } from './errorReport'
import {
  CHECKING_AUTH,
  failedAuth,
  hasCompletedSetup,
  pickAuth,
  rememberSetupComplete,
  setupAttention
} from './startup'

type Phase = 'loading' | 'setup' | 'ready'

// Keep the playful splash on screen long enough to actually be seen on a first
// launch, even when the startup checks resolve almost instantly. A computer that
// already passed setup skips it and opens straight into the app.
const SPLASH_MIN_MS = 2500
const SPLASH_MIN_MS_REDUCED = 700

const ALL_PROVIDERS: AuthProvider[] = ['copilot', 'rayfin', 'az']
/** Setup gates entry on these; the slower Fabric check only matters inside the app. */
const SETUP_PROVIDERS: AuthProvider[] = ['copilot', 'az']

/**
 * Note how things stood at startup in the activity journal.
 *
 * This is the anchor that keeps the journal honest. Without a periodic "and
 * everything was fine here", a failure from last week still reads as the most
 * recent word on the subject, and the Help assistant reports it as live.
 *
 * Written once per launch. React can mount the app more than once — a dev-mode
 * remount, a hot reload — and a journal that repeats the same line four times
 * for one launch is harder to read, not easier.
 */
let startupRecorded = false

function recordStartup(ready: boolean, doctor: DoctorReport | null): void {
  if (startupRecorded) return
  startupRecorded = true
  if (ready) {
    reportEvent(
      'app',
      'app.ready',
      'Fabricator started. All required tools are ready and both accounts are connected.'
    )
    return
  }
  const missing = doctor?.tools.filter((t) => t.required && !t.satisfied).length ?? 0
  reportEvent(
    'setup',
    'app.setup_needed',
    missing > 0
      ? `Fabricator started on the setup screen; ${missing} tool(s) still need to be installed.`
      : 'Fabricator started on the setup screen; setup is not finished yet.',
    { level: 'warn' }
  )
}

/** Test seam: let each test observe the once-per-launch record. */
export function resetStartupRecordForTests(): void {
  startupRecorded = false
}

function App(): JSX.Element {
  // Decided once per launch: after setup has passed here, open the app at once
  // and verify tools and accounts in the background.
  const [returning] = useState(hasCompletedSetup)
  const [setupDone, setSetupDone] = useState(returning)
  const [phase, setPhase] = useState<Phase>(returning ? 'ready' : 'loading')
  const [doctor, setDoctor] = useState<DoctorReport | null>(null)
  const [auth, setAuth] = useState<AuthStatus | null>(returning ? CHECKING_AUTH : null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  const mountedRef = useRef(false)
  const refreshSeqRef = useRef(0)
  /** Per-provider generations, so an older result never overwrites a newer check. */
  const authSeqRef = useRef<Record<AuthProvider, number>>({ copilot: 0, rayfin: 0, az: 0 })
  const phaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toast = useToast()
  const { blocking } = useUpdates()

  // Don't leave the first-run splash before its minimum showtime has elapsed.
  const gateUntilRef = useRef(
    returning
      ? 0
      : Date.now() +
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

  /**
   * Verify `providers` and merge each result, unless a newer check of that
   * provider started meanwhile. Resolves with what was verified. When the check
   * itself fails, those providers read as signed out with the error (never as a
   * stale success) and it rejects with a user-facing message.
   */
  const checkAuth = useCallback(
    async (providers: AuthProvider[]): Promise<Partial<AuthStatus>> => {
      const tickets = providers.map((p) => [p, ++authSeqRef.current[p]] as const)
      const current = (): AuthProvider[] =>
        tickets.filter(([p, seq]) => authSeqRef.current[p] === seq).map(([p]) => p)
      let result: Partial<AuthStatus>
      try {
        result =
          providers.length === ALL_PROVIDERS.length
            ? await window.api.auth.status()
            : await window.api.auth.check(providers)
      } catch (reason) {
        const error = authErrorMessage(reason, 'Could not verify sign-in. Please retry.')
        const failed = mountedRef.current ? current() : []
        // Superseded by a newer check: that one reports.
        if (failed.length === 0) return {}
        setAuth((prev) => ({ ...(prev ?? CHECKING_AUTH), ...failedAuth(failed, error) }))
        throw new Error(error)
      }
      if (mountedRef.current) {
        const fresh = pickAuth(result, current())
        setAuth((prev) => ({ ...(prev ?? CHECKING_AUTH), ...fresh }))
      }
      return result
    },
    []
  )

  /**
   * Check the tools and the sign-ins setup needs, then show setup — or, with
   * `enterWhenReady` at startup, open the app when everything is in place. The
   * Fabric check runs alongside; only the app shows it.
   */
  const refresh = useCallback(
    async ({ enterWhenReady = false }: { enterWhenReady?: boolean } = {}): Promise<void> => {
      const seq = ++refreshSeqRef.current
      setRefreshing(true)
      setCheckError(null)
      setAuthError(null)
      void checkAuth(['rayfin']).catch(() => {})
      const [d, a] = await Promise.allSettled([
        Promise.resolve().then(() => window.api.doctor.check()),
        checkAuth(SETUP_PROVIDERS)
      ])
      if (!mountedRef.current || seq !== refreshSeqRef.current) return
      if (d.status === 'fulfilled') {
        setDoctor(d.value)
      } else {
        setDoctor(null)
        setCheckError(authErrorMessage(d.reason, 'Could not check the installed tools. Please retry.'))
      }
      if (a.status === 'rejected') {
        setAuthError(authErrorMessage(a.reason, 'Could not verify sign-in. Please retry.'))
      }
      const ready =
        d.status === 'fulfilled' &&
        d.value.ready &&
        a.status === 'fulfilled' &&
        Boolean(a.value.copilot?.signedIn) &&
        Boolean(a.value.az?.signedIn)
      if (enterWhenReady && ready) {
        // Nothing to set up: skip the checklist.
        rememberSetupComplete()
        setSetupDone(true)
        applyPhase('ready')
      } else {
        applyPhase('setup')
      }
      recordStartup(ready, d.status === 'fulfilled' ? d.value : null)
      setRefreshing(false)
    },
    [applyPhase, checkAuth]
  )

  const recheck = useCallback((): Promise<void> => refresh(), [refresh])

  /** After setup has passed: open the app right away and check in the background. */
  const verifyInBackground = useCallback(async (): Promise<void> => {
    const seq = ++refreshSeqRef.current
    const tools = Promise.resolve()
      .then(() => window.api.doctor.check())
      .then((result) => {
        if (mountedRef.current && seq === refreshSeqRef.current) setDoctor(result)
        return result
      })
    tools.catch((reason) => {
      if (mountedRef.current && seq === refreshSeqRef.current) {
        setCheckError(authErrorMessage(reason, 'Could not check the installed tools. Please retry.'))
      }
    })
    const [report, accounts] = await Promise.allSettled([
      tools,
      checkAuth(SETUP_PROVIDERS),
      checkAuth(['rayfin'])
    ])
    const doctorReport = report.status === 'fulfilled' ? report.value : null
    // This is the common launch path, so it is also the one that most needs an
    // "everything was fine" marker in the journal.
    recordStartup(
      Boolean(doctorReport?.ready) &&
        accounts.status === 'fulfilled' &&
        Boolean(accounts.value.copilot?.signedIn) &&
        Boolean(accounts.value.az?.signedIn),
      doctorReport
    )
  }, [checkAuth])

  /** Re-verify every account without leaving the app; rejects when verification fails. */
  const refreshAuth = useCallback(async (): Promise<void> => {
    try {
      await checkAuth(ALL_PROVIDERS)
      if (mountedRef.current) setAuthError(null)
    } catch (reason) {
      const error = authErrorMessage(reason, 'Could not verify sign-in. Please retry.')
      if (mountedRef.current) setAuthError(error)
      throw new Error(error)
    }
  }, [checkAuth])

  // Explicit transition into the workbench, triggered by the setup screen's
  // "Enter" button once every prerequisite is satisfied.
  const enter = useCallback((): void => {
    if (refreshing || !doctor?.ready || !auth?.copilot.signedIn || !auth.az.signedIn) return
    ++refreshSeqRef.current
    if (phaseTimerRef.current !== null) {
      clearTimeout(phaseTimerRef.current)
      phaseTimerRef.current = null
    }
    rememberSetupComplete()
    reportEvent(
      'setup',
      'setup.completed',
      `Setup finished: all ${doctor.tools.filter((t) => t.required).length} required tools are ready and both accounts are connected.`
    )
    setSetupDone(true)
    setPhase('ready')
  }, [auth, doctor, refreshing])

  /** Leave the app for setup (e.g. a tool went missing), re-checking everything. */
  const reviewSetup = useCallback((): void => {
    if (phaseTimerRef.current !== null) {
      clearTimeout(phaseTimerRef.current)
      phaseTimerRef.current = null
    }
    gateUntilRef.current = 0
    setPhase('setup')
    void refresh()
  }, [refresh])

  /** Return from setup to the app without finishing it (setup passed here before). */
  const backToApp = useCallback((): void => {
    ++refreshSeqRef.current
    if (phaseTimerRef.current !== null) {
      clearTimeout(phaseTimerRef.current)
      phaseTimerRef.current = null
    }
    setRefreshing(false)
    setPhase('ready')
  }, [])

  useEffect(() => {
    let alive = true
    mountedRef.current = true
    void (returning ? verifyInBackground() : refresh({ enterWhenReady: true }))
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
      for (const provider of ALL_PROVIDERS) ++authSeqRef.current[provider]
      if (phaseTimerRef.current !== null) clearTimeout(phaseTimerRef.current)
    }
  }, [refresh, verifyInBackground, returning, toast])

  // Apply the theme app-wide (covers splash + setup, not just the workbench)
  // and follow the OS when set to 'system'.
  useEffect(() => {
    if (!settings) return
    applyUiScale(settings.uiScale)
    return watchTheme(settings.theme)
  }, [settings])

  const updateSettings = useCallback(async (patch: Partial<AppSettings>): Promise<void> => {
    try {
      setSettings(await window.api.settings.set(patch))
    } catch (reason) {
      toast.error(authErrorMessage(reason, 'Could not save settings. Please try again.'), {
        title: 'Settings not saved'
      })
    }
  }, [toast])

  const attention = useMemo(() => setupAttention(doctor, auth, checkError), [doctor, auth, checkError])
  // Ray is on unless turned off in Settings, including before settings load.
  const mascot = settings?.mascot !== false

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
      <MascotProvider enabled={mascot}>
        <UpdateBanner />
        <UpdateModal />
        <Workbench
          auth={auth}
          attention={attention}
          onReviewSetup={reviewSetup}
          onAuthChanged={refreshAuth}
          settings={settings}
          onSettingsChange={updateSettings}
        />
      </MascotProvider>
    )
  }

  return (
    <MascotProvider enabled={mascot}>
      <UpdateBanner />
      <UpdateModal />
      <SetupScreen
        doctor={doctor}
        auth={auth}
        error={[checkError, authError].filter(Boolean).join(' ') || undefined}
        refreshing={refreshing}
        onRefresh={recheck}
        onEnter={enter}
        onBack={setupDone ? backToApp : undefined}
      />
    </MascotProvider>
  )
}

export default App
