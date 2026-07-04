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
