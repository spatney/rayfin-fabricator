import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type { AppUpdateInfo, UpdateProgress } from '@shared/ipc'

/**
 * In-app update state, shared between the app-wide {@link UpdateBanner} and the
 * "Check for updates" control in Settings.
 *
 * On startup (production builds only) the app checks GitHub Releases and, if a
 * newer signed release exists, downloads its installer in the background and
 * surfaces a banner. The user confirms, and `install()` applies the update and
 * restarts. All of this is driven by Rust (`window.api.updates`, backed by the
 * Tauri updater); the renderer only orchestrates the UX.
 */

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error'

export interface UpdateApi {
  status: UpdateStatus
  info: AppUpdateInfo | null
  progress: UpdateProgress | null
  /**
   * True once a mandatory (startup) update is found and is downloading,
   * installing, or ready: the app must block all UI behind it until it applies.
   * Stays false for the optional Settings-driven flow and when offline/up to date.
   */
  blocking: boolean
  /** Manually check, and download in the background if an update is found. */
  checkNow: (opts?: { mandatory?: boolean }) => Promise<void>
  /** Install the downloaded update and restart the app. */
  install: () => Promise<void>
  /** Hide the banner for now (until the next check finds an update). No-op while mandatory. */
  dismiss: () => void
}

const UpdateContext = createContext<UpdateApi | null>(null)

export function UpdateProvider({ children }: { children: ReactNode }): JSX.Element {
  const [status, setStatus] = useState<UpdateStatus>('idle')
  const [info, setInfo] = useState<AppUpdateInfo | null>(null)
  const [progress, setProgress] = useState<UpdateProgress | null>(null)
  const [mandatory, setMandatory] = useState(false)
  const mandatoryRef = useRef(false)
  const dismissed = useRef(false)
  const startedAutoCheck = useRef(false)

  useEffect(() => window.api.updates.onProgress((p) => setProgress(p)), [])

  const install = useCallback(async (): Promise<void> => {
    setStatus('installing')
    try {
      await window.api.updates.install()
      // On success the app restarts, so nothing else runs here.
    } catch (err) {
      console.error('[update] install failed', err)
      // A failed install can't hard-lock the app: drop the mandatory gate so the
      // user can keep working and retry later.
      mandatoryRef.current = false
      setMandatory(false)
      setStatus('error')
    }
  }, [])

  const download = useCallback(async (): Promise<void> => {
    setStatus('downloading')
    setProgress(null)
    try {
      const found = await window.api.updates.download()
      if (dismissed.current) return
      if (found) {
        setInfo(found)
        setStatus('ready')
        // Mandatory startup updates install themselves the moment they're ready.
        if (mandatoryRef.current) void install()
      } else {
        setStatus('idle')
      }
    } catch (err) {
      console.error('[update] download failed', err)
      // Don't trap the user offline: release the gate and let them proceed.
      mandatoryRef.current = false
      setMandatory(false)
      if (!dismissed.current) setStatus('error')
    }
  }, [install])

  const checkNow = useCallback(
    async (opts?: { mandatory?: boolean }): Promise<void> => {
      dismissed.current = false
      mandatoryRef.current = opts?.mandatory ?? false
      setMandatory(opts?.mandatory ?? false)
      setStatus('checking')
      try {
        const found = await window.api.updates.check()
        if (!found) {
          mandatoryRef.current = false
          setMandatory(false)
          setInfo(null)
          setStatus('idle')
          return
        }
        setInfo(found)
        await download()
      } catch (err) {
        console.error('[update] check failed', err)
        mandatoryRef.current = false
        setMandatory(false)
        setStatus('error')
      }
    },
    [download]
  )

  const dismiss = useCallback(() => {
    // Mandatory updates can't be dismissed — they block until applied.
    if (mandatoryRef.current) return
    dismissed.current = true
    setStatus('idle')
  }, [])

  // Automatic background check + download once on startup. Skipped in dev, where
  // there is no published `latest.json` endpoint to hit. Marked mandatory so a
  // found update blocks the app and installs itself; up-to-date or offline
  // launches clear the gate and proceed.
  useEffect(() => {
    if (import.meta.env.DEV || startedAutoCheck.current) return
    startedAutoCheck.current = true
    void checkNow({ mandatory: true })
  }, [checkNow])

  const blocking =
    mandatory && (status === 'downloading' || status === 'ready' || status === 'installing')

  const value: UpdateApi = { status, info, progress, blocking, checkNow, install, dismiss }
  return <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>
}

/** Access the shared in-app update state. Must be used within an `UpdateProvider`. */
export function useUpdates(): UpdateApi {
  const ctx = useContext(UpdateContext)
  if (!ctx) throw new Error('useUpdates must be used within an UpdateProvider')
  return ctx
}
