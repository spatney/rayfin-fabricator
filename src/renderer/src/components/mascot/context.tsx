import { createContext, useContext, useEffect, useState } from 'react'

/**
 * Whether Ray may appear. On unless Settings → Appearance → Ray is turned
 * off, so anything rendered outside the provider (tests, previews) gets him.
 * Provided by `MascotProvider` in ./stage.
 */
export const MascotContext = createContext(true)

export function useMascot(): boolean {
  return useContext(MascotContext)
}

function reducedQuery(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null
}

/** True when the OS asks for less motion. Ray then stays put and skips his tricks. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => reducedQuery()?.matches ?? false)
  useEffect(() => {
    const query = reducedQuery()
    if (!query || typeof query.addEventListener !== 'function') return
    const onChange = (): void => setReduced(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return reduced
}
