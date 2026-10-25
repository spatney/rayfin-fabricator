import { useEffect, useState, useSyncExternalStore } from 'react'
import type { AutoTiers, CopilotModel, ReasoningEffort } from '@shared/ipc'

// Module-level cache so the per-user model list is fetched once and shared across
// every ChatPanel instance, rather than re-queried on each open.
let modelsCache: CopilotModel[] | null = null
let modelsPromise: Promise<CopilotModel[]> | null = null
// What Auto can optimize for: account-bound like the models, so cleared with them.
let tiersCache: { value: AutoTiers | null } | null = null
let tiersPromise: Promise<AutoTiers | null> | null = null
let generation = 0
const listeners = new Set<() => void>()
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
const snapshot = (): number => generation

/** Forget the models (and Auto's options), e.g. after a sign-in change or new API keys. */
export function invalidateCopilotModels(): void {
  generation += 1
  modelsCache = null
  modelsPromise = null
  tiersCache = null
  tiersPromise = null
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

function loadAutoTiers(): Promise<AutoTiers | null> {
  if (tiersCache) return Promise.resolve(tiersCache.value)
  if (!tiersPromise) {
    const current = generation
    tiersPromise = new Promise<AutoTiers | null>((resolve) => resolve(window.api.chat.autoTiers()))
      .then((value) => {
        if (current === generation) tiersCache = { value }
        return value
      })
      .catch((err) => {
        if (current === generation) tiersPromise = null
        throw err
      })
  }
  return tiersPromise
}

/** What Auto can optimize for on this account, once `enabled`; null while
 *  unknown, or when Copilot offers no choice. */
export function useAutoTiers(enabled: boolean): AutoTiers | null {
  const revision = useSyncExternalStore(subscribe, snapshot)
  const [tiers, setTiers] = useState<AutoTiers | null>(tiersCache?.value ?? null)
  useEffect(() => {
    if (tiersCache) {
      setTiers(tiersCache.value)
      return
    }
    setTiers(null)
    if (!enabled) return
    let cancelled = false
    loadAutoTiers()
      .then((value) => {
        if (!cancelled) setTiers(value)
      })
      .catch((error) => console.warn('Could not load Auto’s options', error))
    return () => {
      cancelled = true
    }
  }, [enabled, revision])
  return tiers
}

/** A model on the user's own API key: its selection id names the provider
 *  (`anthropic/claude-sonnet-5-5`); Copilot's ids never contain a slash. */
export function isProviderModelId(id: string | undefined): boolean {
  return Boolean(id?.includes('/'))
}

/** Name tokens that mark a small/fast model when Copilot doesn't report a tier. */
const FAST_TOKENS = new Set(['haiku', 'flash', 'mini', 'nano', 'lite', 'small'])

/** Whole words of a model's id and name (`gemini-2.5-pro` → gemini, 2, 5, pro). */
function nameTokens(m: CopilotModel): string[] {
  return `${m.id} ${m.name}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

/** Whether a model is small/fast: Copilot's lightweight tier, or a fast family
 *  name such as Flash, Haiku or mini — never a powerful-tier model. */
export function isFastModel(m: CopilotModel): boolean {
  if (m.category === 'powerful') return false
  if (m.category === 'lightweight') return true
  return nameTokens(m).some((t) => FAST_TOKENS.has(t))
}

/** The model Design uses for its quick, one-shot calls (Options and Polish). */
export interface DesignModelPick {
  /** Model id; undefined lets Copilot use its default. */
  id?: string
  name?: string
  /** Reasoning effort to request, when the model supports it. */
  effort?: ReasoningEffort
  /** The model accepts images (an element screenshot can ride along). */
  vision: boolean
}

/**
 * Models Design prefers for Options and Polish, fastest first, from benchmarking
 * real Options requests with the brand-aware prompt (Oct 2026; KPI card, page
 * section and chart, 2 runs each; re-run with scripts/design-bench). Median time
 * to all three options: Claude Haiku 5.5 at low effort 6.2 s (first option
 * ~2.5 s), GPT-6 Luna 7.5 s, MAI Code 1.1 Flash 10.9 s, Gemini 3.7 Flash 12.7 s,
 * Gemini 3.8 Flash 18 s; Haiku 4.5 took 15.4 s and stayed less on brand. Default
 * effort was 2–3× slower than low.
 */
const DESIGN_PREFERRED = ['claude-haiku-5.5', 'gpt-6-luna', 'mai-code-1.1-flash', 'gemini-3.7-flash', 'gemini-3.8-flash']
const PRICE_RANK: Record<string, number> = { low: 0, medium: 1 }

/** The numbers in a model id, in order (`gemini-3.8-flash` → [3, 8]). */
function versionOf(id: string): number[] {
  return (id.match(/\d+/g) ?? []).map(Number)
}

function newerFirst(a: CopilotModel, b: CopilotModel): number {
  const va = versionOf(a.id)
  const vb = versionOf(b.id)
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (vb[i] ?? -1) - (va[i] ?? -1)
    if (d) return d
  }
  return 0
}

/**
 * Pick the model for Design's Options and Polish: the fastest benchmarked model
 * the account has, else a newer lightweight model that can be told to think
 * less, else another cheap lightweight model, else a low-cost versatile one.
 * Powerful and high-cost models, and models on the user's own API keys, are
 * never picked automatically; with no candidate the id is left undefined
 * (Copilot's default).
 */
export function pickDesignModel(models: CopilotModel[]): DesignModelPick {
  const usable = models.filter(
    (m) =>
      !m.byok &&
      m.category !== 'powerful' &&
      m.priceCategory !== 'high' &&
      m.priceCategory !== 'very_high'
  )
  const light = (m: CopilotModel): boolean => m.category === 'lightweight' || (!m.category && isFastModel(m))
  const lowEffort = (m: CopilotModel): boolean => m.supportedReasoningEfforts.includes('low')
  const pick =
    DESIGN_PREFERRED.map((id) => usable.find((m) => m.id === id)).find(Boolean) ??
    usable.filter((m) => light(m) && lowEffort(m)).sort(newerFirst)[0] ??
    usable
      .filter(light)
      .sort((a, b) => (PRICE_RANK[a.priceCategory ?? ''] ?? 2) - (PRICE_RANK[b.priceCategory ?? ''] ?? 2) || newerFirst(a, b))[0] ??
    usable.find((m) => m.category === 'versatile' && m.priceCategory === 'low')
  if (!pick) return { vision: false }
  return {
    id: pick.id,
    name: pick.name,
    effort: lowEffort(pick) ? 'low' : undefined,
    vision: pick.vision === true
  }
}

/**
 * The model Design uses: the one chosen in the Design bar (Your own API keys
 * experiment), else its automatic pick. A chosen model the list doesn't have is
 * still asked for by id, so the run says why it can't use it.
 */
export function resolveDesignModel(
  models: CopilotModel[],
  choice?: { model: string; effort: ReasoningEffort | '' } | null
): DesignModelPick {
  if (!choice?.model) return pickDesignModel(models)
  const chosen = models.find((m) => m.id === choice.model)
  return {
    id: choice.model,
    name: chosen?.name,
    effort: choice.effort || undefined,
    vision: chosen?.vision === true
  }
}
