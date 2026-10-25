import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type JSX,
} from 'react'
import type { AppUpdateInfo, UpdateProgress } from '@shared/ipc'

/**
 * In-app update state, shared by the app-wide {@link UpdateBanner} and the
 * startup {@link UpdateModal}.
 *
 * On startup (production builds only) the app checks GitHub Releases and, if a
 * newer signed release exists, downloads its installer in the background and
 * surfaces a centered modal. The user chooses "Update now" (`install()` applies
 * the update and restarts) or "Later" (boots into the app, leaving a banner
 * reminder). All of this is driven by Rust (`window.api.updates`, backed by the
 * Tauri updater); the renderer only orchestrates the UX.
 *
 * While the app stays open it checks again in the background (see
 * {@link RECHECK_MS}), and as soon as the connection comes back after a failed
 * check, so a window left open for days still hears about a release. A release
 * found that way is offered in the banner, never the modal.
 *
 * Startup updates are optional so a user on a working version can decline a
 * broken release. The mandatory/`blocking` path (see {@link ForcedUpdateScreen})
 * is retained but unused by default, so a future critical release can still be
 * forced via `checkNow({ mandatory: true })`.
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
   * Stays false for optional updates and when offline/up to date.
   */
  blocking: boolean
  /**
   * True when the optional startup update prompt should be shown as a centered
   * modal: an automatic check has produced a downloaded, ready-to-install update
   * that the user hasn't yet deferred. Never true for the mandatory/`blocking`
   * flow. Drives {@link UpdateModal}; the {@link UpdateBanner} hides while it's up.
   */
  modalOpen: boolean
  /** Check now, and download in the background if an update is found. */
  checkNow: (opts?: { mandatory?: boolean; auto?: boolean }) => Promise<void>
  /** Install the downloaded update and restart the app. */
  install: () => Promise<void>
  /**
   * Defer the startup modal: close it and boot into the app, keeping the update
   * ready so the {@link UpdateBanner} can offer it later. No-op while mandatory.
   */
  later: () => void
  /**
   * Put the update off until the next launch: hide the banner, and leave it out
   * of the background checks. No-op while mandatory.
   */
  dismiss: () => void
}

/** How often an open app checks again for an update. */
export const RECHECK_MS = 4 * 60 * 60 * 1000

const UpdateContext = createContext<UpdateApi | null>(null)

export function UpdateProvider({ children }: { children: ReactNode }): JSX.Element {
  const [status, setStatus] = useState<UpdateStatus>('idle')
  const statusRef = useRef(status)
  statusRef.current = status
  const [info, setInfo] = useState<AppUpdateInfo | null>(null)
  const [progress, setProgress] = useState<UpdateProgress | null>(null)
  const [mandatory, setMandatory] = useState(false)
  // Was the in-flight check the automatic startup one (vs. a later background
  // check)? Only the startup check surfaces the centered modal.
  const [auto, setAuto] = useState(false)
  // The user clicked "Later" on the startup modal: close it but keep the update
  // ready so the banner can still offer it.
  const [deferred, setDeferred] = useState(false)
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
    async (opts?: { mandatory?: boolean; auto?: boolean }): Promise<void> => {
      dismissed.current = false
      setDeferred(false)
      setAuto(opts?.auto ?? false)
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

  const later = useCallback(() => {
    // Mandatory updates can't be deferred — they block until applied.
    if (mandatoryRef.current) return
    // Close the modal but keep `status` ('ready') so the banner keeps offering it.
    setDeferred(true)
  }, [])

  // Automatic background check + download once on startup. Skipped in dev, where
  // there is no published `latest.json` endpoint to hit. Optional (`auto`, not
  // mandatory): a found update downloads in the background and then surfaces the
  // centered modal so the user can update now or continue; up-to-date or offline
  // launches proceed silently.
  useEffect(() => {
    if (import.meta.env.DEV || startedAutoCheck.current) return
    startedAutoCheck.current = true
    void checkNow({ auto: true })
  }, [checkNow])

  // While the app stays open, check again every few hours, and as soon as the
  // connection comes back after a failed check. Never while an update is under
  // way or waiting, or once the user has put one off until the next launch.
  useEffect(() => {
    if (import.meta.env.DEV) return
    const recheck = (): void => {
      const current = statusRef.current
      if (current === 'error' || (current === 'idle' && !dismissed.current)) void checkNow()
    }
    const onOnline = (): void => {
      if (statusRef.current === 'error') void checkNow()
    }
    const timer = window.setInterval(recheck, RECHECK_MS)
    window.addEventListener('online', onOnline)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('online', onOnline)
    }
  }, [checkNow])

  const blocking =
    mandatory && (status === 'downloading' || status === 'ready' || status === 'installing')

  // The optional startup prompt: an automatic check produced a ready (or
  // installing) update the user hasn't deferred. Never overlaps the mandatory
  // `blocking` screen.
  const modalOpen =
    auto && !deferred && !blocking && (status === 'ready' || status === 'installing')

  const value: UpdateApi = {
    status,
    info,
    progress,
    blocking,
    modalOpen,
    checkNow,
    install,
    later,
    dismiss
  }
  return <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>
}

/** Access the shared in-app update state. Must be used within an `UpdateProvider`. */
export function useUpdates(): UpdateApi {
  const ctx = useContext(UpdateContext)
  if (!ctx) throw new Error('useUpdates must be used within an UpdateProvider')
  return ctx
}
