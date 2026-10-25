import type { JSX, ReactNode } from 'react'
import { useSuppressPreview } from '../overlay'
import { useRayOnScreen } from './mascot/stage'

/**
 * The launch screen's frame. It covers the app while the screen underneath
 * loads, then fades away to reveal it (`leaving`). While it's up, the native
 * preview stays off screen — it paints above all HTML and would show through —
 * and the roaming Ray stays away, since the launch screen has its own.
 */
export default function LaunchCurtain({
  leaving,
  children
}: {
  leaving: boolean
  children: ReactNode
}): JSX.Element {
  useSuppressPreview(true)
  useRayOnScreen(true)
  return (
    <div
      className={`launch-curtain${leaving ? ' launch-curtain--leaving' : ''}`}
      aria-hidden={leaving || undefined}
    >
      {children}
    </div>
  )
}
