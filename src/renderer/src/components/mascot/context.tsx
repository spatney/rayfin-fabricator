import { useEffect, useState } from 'react'

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
