import { useEffect, useState, useSyncExternalStore } from 'react'
import type { CopilotModel } from '@shared/ipc'

// Module-level cache so the per-user model list is fetched once and shared across
// every ChatPanel instance, rather than re-queried on each open.
let modelsCache: CopilotModel[] | null = null
let modelsPromise: Promise<CopilotModel[]> | null = null
let generation = 0
const listeners = new Set<() => void>()
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
const snapshot = (): number => generation

export function invalidateCopilotModels(): void {
  generation += 1
  modelsCache = null
  modelsPromise = null
  listeners.forEach((listener) => listener())
}

export function loadCopilotModels(): Promise<CopilotModel[]> {
  if (modelsCache) return Promise.resolve(modelsCache)
  if (!modelsPromise) {
    const current = generation
    modelsPromise = window.api.chat
      .listModels()
      .then((list) => {
        if (current === generation) modelsCache = list
        return list
      })
      .catch((err) => {
        if (current === generation) modelsPromise = null // allow a retry on the next request
        throw err
      })
  }
  return modelsPromise
}

/** Fetch the available models once `enabled`, keeping any static fallback until
 * they arrive (or if the engine can't be reached). */
export function useCopilotModels(enabled: boolean): { models: CopilotModel[]; loading: boolean } {
  const revision = useSyncExternalStore(subscribe, snapshot)
  const [models, setModels] = useState<CopilotModel[]>(modelsCache ?? [])
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (modelsCache) {
      setModels(modelsCache)
      return
    }
    setModels([])
    if (!enabled) return
    let cancelled = false
    setLoading(true)
    loadCopilotModels()
      .then((list) => {
        if (!cancelled) setModels(list)
      })
      .catch((error) => {
        console.warn('Could not load Copilot models', error)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [enabled, revision])
  return { models, loading }
}

/** Substrings that mark a model as small/fast (cheap, low-latency). */
const FAST_HINTS = ['haiku', 'flash', 'mini', 'lite', 'small', 'fast', 'nano']

/** Whether a model looks small/fast by its id/name (see {@link FAST_HINTS}). */
export function isFastModel(m: CopilotModel): boolean {
  const s = `${m.id} ${m.name}`.toLowerCase()
  return FAST_HINTS.some((h) => s.includes(h))
}

/**
 * Pick a fast/cheap model id for one-shot, latency-sensitive generation (e.g. the
 * design-mode "Generate with AI" placeholder). Returns `undefined` when none
 * match (caller falls back to the engine default).
 */
export function pickFastModel(models: CopilotModel[]): string | undefined {
  return models.find(isFastModel)?.id
}
