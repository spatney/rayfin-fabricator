import { useEffect, useState } from 'react'
import type { CopilotModel } from '@shared/ipc'

// Module-level cache so the per-user model list is fetched once and shared across
// every ChatPanel instance, rather than re-queried on each open.
let modelsCache: CopilotModel[] | null = null
let modelsPromise: Promise<CopilotModel[]> | null = null

export function loadCopilotModels(): Promise<CopilotModel[]> {
  if (modelsCache) return Promise.resolve(modelsCache)
  if (!modelsPromise) {
    modelsPromise = window.api.chat
      .listModels()
      .then((list) => {
        modelsCache = list
        return list
      })
      .catch((err) => {
        modelsPromise = null // allow a retry on the next request
        throw err
      })
  }
  return modelsPromise
}

/** Fetch the available models once `enabled`, keeping any static fallback until
 * they arrive (or if the engine can't be reached). */
export function useCopilotModels(enabled: boolean): { models: CopilotModel[]; loading: boolean } {
  const [models, setModels] = useState<CopilotModel[]>(modelsCache ?? [])
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!enabled || modelsCache) return
    let cancelled = false
    setLoading(true)
    loadCopilotModels()
      .then((list) => {
        if (!cancelled) setModels(list)
      })
      .catch(() => {
        /* keep the static fallback */
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [enabled])
  return { models, loading }
}

/** Substrings that mark a model as small/fast (cheap, low-latency). */
const FAST_HINTS = ['haiku', 'flash', 'mini', 'lite', 'small', 'fast', 'nano']

/**
 * Pick a fast/cheap model id for one-shot, latency-sensitive generation (e.g. the
 * design-mode "Generate with AI" placeholder). Matches a name/id against
 * {@link FAST_HINTS}; returns `undefined` when none match (caller falls back to
 * the engine default).
 */
export function pickFastModel(models: CopilotModel[]): string | undefined {
  const hit = models.find((m) => {
    const s = `${m.id} ${m.name}`.toLowerCase()
    return FAST_HINTS.some((h) => s.includes(h))
  })
  return hit?.id
}
