import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode
} from 'react'

/**
 * Overlay registry — decouples "something is painted over the preview" from the
 * preview itself.
 *
 * The live preview is a native WebView2 child surface that always paints above
 * ALL HTML (CSS z-index cannot lift HTML above it). So whenever the app shows a
 * modal, menu, or full-window overlay, the native preview must be hidden or it
 * would cover that UI. Rather than maintaining one central list of every overlay
 * flag and threading a `suppressed` prop into the preview, each overlay registers
 * itself here while it is on screen and the preview reads whether *any* overlay
 * is currently active.
 *
 * Usage:
 *   - In a modal/menu component: call `useSuppressPreview()` (active for the
 *     component's whole lifetime) or `useSuppressPreview(open)` to follow an
 *     internal open flag.
 *   - For a bespoke inline overlay that isn't its own component: drop a
 *     `<SuppressPreview />` marker inside the conditionally-rendered block.
 *   - The preview calls `usePreviewSuppressed()` to know when to hide.
 */

interface OverlayApi {
  register: (id: string) => void
  unregister: (id: string) => void
}

// Two contexts on purpose: the register/unregister API is stable (never changes
// identity) so overlay effects don't churn, while only the boolean flips.
const OverlayApiContext = createContext<OverlayApi | null>(null)
const OverlayActiveContext = createContext(false)

export function OverlayProvider({ children }: { children: ReactNode }): JSX.Element {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set<string>())

  const api = useMemo<OverlayApi>(
    () => ({
      register: (id) =>
        setIds((prev) => {
          if (prev.has(id)) return prev
          const next = new Set(prev)
          next.add(id)
          return next
        }),
      unregister: (id) =>
        setIds((prev) => {
          if (!prev.has(id)) return prev
          const next = new Set(prev)
          next.delete(id)
          return next
        })
    }),
    []
  )

  return (
    <OverlayApiContext.Provider value={api}>
      <OverlayActiveContext.Provider value={ids.size > 0}>{children}</OverlayActiveContext.Provider>
    </OverlayApiContext.Provider>
  )
}

/** True while any overlay is registered — the preview uses this to hide. */
export function usePreviewSuppressed(): boolean {
  return useContext(OverlayActiveContext)
}

/**
 * Register the calling component as an overlay that must hide the native preview
 * while `active` (default `true`, i.e. for the component's whole lifetime). Keyed
 * by a stable per-instance id and cleaned up automatically on unmount.
 */
export function useSuppressPreview(active = true): void {
  const api = useContext(OverlayApiContext)
  const id = useId()
  useEffect(() => {
    if (!api || !active) return
    api.register(id)
    return () => api.unregister(id)
  }, [api, active, id])
}

/** Marker for bespoke inline overlays: render inside the overlay's JSX block. */
export function SuppressPreview(): null {
  useSuppressPreview(true)
  return null
}
