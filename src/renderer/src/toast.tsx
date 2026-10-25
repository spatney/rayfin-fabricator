import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type JSX,
} from 'react'
import { inferArea, reportError, reportEvent } from './errorReport'

export type ToastKind = 'success' | 'error' | 'info'

export interface ToastOptions {
  /** Optional bold title shown above the message. */
  title?: string
  /** Milliseconds before auto-dismiss; `0` keeps it until dismissed. Defaults by kind. */
  duration?: number
  /**
   * Set `false` when the caller already recorded this (usually via
   * `reportThrown`, which keeps the stack trace, or `reportEvent` with more
   * context). Stops the same thing being written to the activity journal twice,
   * which would crowd out other entries in the recent window the Help assistant
   * reads.
   */
  record?: boolean
}

interface Toast {
  id: number
  kind: ToastKind
  message: string
  title?: string
  duration: number
}

export interface ToastApi {
  show: (kind: ToastKind, message: string, opts?: ToastOptions) => number
  success: (message: string, opts?: ToastOptions) => number
  error: (message: string, opts?: ToastOptions) => number
  info: (message: string, opts?: ToastOptions) => number
  dismiss: (id: number) => void
}

/** Errors linger longer than confirmations; both auto-dismiss by default. */
const DEFAULT_DURATION: Record<ToastKind, number> = {
  success: 4000,
  info: 5000,
  error: 8000
}

/** Most recent toasts win; the stack is capped so it can't grow without bound. */
const MAX_TOASTS = 4

const ICON: Record<ToastKind, string> = {
  success: '✓',
  error: '!',
  info: 'i'
}

const ToastContext = createContext<ToastApi | null>(null)

/**
 * No-op fallback returned when {@link useToast} is called without a provider in
 * the tree. Toasts are auxiliary feedback, so a momentarily-missing provider
 * (e.g. a hot-reload remount that swaps the context instance) must degrade
 * silently rather than crash the whole app — mirroring the graceful fallback the
 * overlay hooks use.
 */
const NOOP_TOAST: ToastApi = {
  show: () => -1,
  success: () => -1,
  error: () => -1,
  info: () => -1,
  dismiss: () => {}
}

/** Access the toast API. Intended to be called within a {@link ToastProvider}. */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) {
    if (import.meta.env.DEV) {
      console.warn('useToast called outside <ToastProvider>; toasts are disabled for this render.')
    }
    return NOOP_TOAST
  }
  return ctx
}

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([])
  const idRef = useRef(0)
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: number): void => {
    setToasts((list) => list.filter((t) => t.id !== id))
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
  }, [])

  const show = useCallback(
    (kind: ToastKind, message: string, opts?: ToastOptions): number => {
      // Everything the user is *told* is recorded, so the Help assistant can
      // explain it later. Successes matter as much as errors: without them, a
      // journal of pure failure makes a working app look broken and hides the
      // fact that a retry went through. This is the one place they all pass
      // through, unless the caller already recorded it with more detail.
      if (opts?.record !== false) {
        const text = opts?.title ? `${opts.title}: ${message}` : message
        const area = inferArea(opts?.title, message)
        if (kind === 'error') {
          reportError({ surface: 'toast', message: text, area })
        } else {
          reportEvent(area, kind === 'success' ? `${area}.succeeded` : `${area}.notice`, text)
        }
      }
      const id = (idRef.current += 1)
      const duration = opts?.duration ?? DEFAULT_DURATION[kind]
      setToasts((list) => [...list, { id, kind, message, title: opts?.title, duration }].slice(-MAX_TOASTS))
      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration)
        )
      }
      return id
    },
    [dismiss]
  )

  // Clear any pending timers when the provider unmounts.
  useEffect(() => {
    const map = timers.current
    return () => {
      map.forEach((t) => clearTimeout(t))
      map.clear()
    }
  }, [])

  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (m, o) => show('success', m, o),
      error: (m, o) => show('error', m, o),
      info: (m, o) => show('info', m, o),
      dismiss
    }),
    [show, dismiss]
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastHost toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  )
}

function ToastHost({
  toasts,
  onDismiss
}: {
  toasts: Toast[]
  onDismiss: (id: number) => void
}): JSX.Element | null {
  if (toasts.length === 0) return null
  return (
    <div className="toast-host" role="region" aria-label="Notifications">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast--${t.kind}`}
          role={t.kind === 'error' ? 'alert' : 'status'}
          aria-live={t.kind === 'error' ? 'assertive' : 'polite'}
        >
          <span className="toast-icon" aria-hidden="true">
            {ICON[t.kind]}
          </span>
          <div className="toast-body">
            {t.title && <div className="toast-title">{t.title}</div>}
            <div className="toast-msg">{t.message}</div>
          </div>
          <button className="toast-close" aria-label="Dismiss notification" onClick={() => onDismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
