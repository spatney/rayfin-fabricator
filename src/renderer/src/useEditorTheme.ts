import { useEffect, useState } from 'react'

/**
 * Track the app's resolved theme so an embedded Monaco editor matches light/dark.
 * Shared by any renderer component that mounts `@monaco-editor/react` — the app
 * flips `data-theme` on `<html>` rather than remounting, so this watches that
 * attribute instead of re-reading it once.
 */
export function useEditorTheme(): 'rayfin-dark' | 'rayfin-light' {
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme !== 'light')
  useEffect(() => {
    const el = document.documentElement
    const obs = new MutationObserver(() => setDark(el.dataset.theme !== 'light'))
    obs.observe(el, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])
  return dark ? 'rayfin-dark' : 'rayfin-light'
}
