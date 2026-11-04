import { useEffect, useRef, useState, type RefObject } from 'react'
import type { FileDropEvent } from '@shared/ipc'

/**
 * A drop target for files and folders dragged onto `target` from the OS: true
 * while such a drag is over it, and `onDrop` gets their paths when they're let
 * go there. The window takes these drops (the page gets no drag events for
 * them), so this checks what's under the pointer. Off while `enabled` is false.
 */
export function useFileDrop(
  target: RefObject<HTMLElement | null>,
  onDrop: (paths: string[]) => void,
  enabled = true
): boolean {
  const [over, setOver] = useState(false)
  const onDropRef = useRef(onDrop)
  onDropRef.current = onDrop
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  useEffect(() => {
    const inside = (point: FileDropEvent['point']): boolean => {
      const element = target.current
      if (!element || !point || !enabledRef.current) return false
      const hit = document.elementFromPoint(point.x, point.y)
      return Boolean(hit && element.contains(hit))
    }
    return window.api.onFileDrop?.((event) => {
      if (event.type === 'leave') {
        setOver(false)
      } else if (event.type === 'drop') {
        setOver(false)
        if (event.paths.length > 0 && inside(event.point)) onDropRef.current(event.paths)
      } else {
        setOver(inside(event.point))
      }
    })
  }, [target])

  return over && enabled
}
