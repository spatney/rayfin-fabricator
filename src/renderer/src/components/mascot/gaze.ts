import { useEffect, type RefObject } from 'react'
import { RAY_EYES } from './Ray'

const clamp1 = (v: number): number => Math.min(1, Math.max(-1, v))

/**
 * Aim Ray's eyes at the pointer, wherever it is in the window. Sets `--ray-lx`
 * and `--ray-ly` on `ref`, which must contain his drawing.
 */
export function useRayGaze(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const el = ref.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const ex = r.left + r.width * RAY_EYES.x
      const ey = r.top + r.height * RAY_EYES.y
      el.style.setProperty('--ray-lx', clamp1((e.clientX - ex) / 260).toFixed(2))
      el.style.setProperty('--ray-ly', clamp1((e.clientY - ey) / 200).toFixed(2))
    }
    window.addEventListener('pointermove', onMove)
    return () => window.removeEventListener('pointermove', onMove)
  }, [ref])
}
