import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'

export type ToastKind = 'success' | 'error' | 'info'

export interface ToastOptions {
  /** Optional bold title shown above the message. */
  title?: string
  /** Milliseconds before auto-dismiss; `0` keeps it until dismissed. Defaults by kind. */
  duration?: number
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

/** Access the toast API. Must be called within a {@link ToastProvider}. */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within a <ToastProvider>')
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
