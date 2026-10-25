import type { ContextTier, ReasoningEffort } from '@shared/ipc'

/** What a model picker chooses. Blank parts aren't set. */
export interface ModelSelection {
  /** The model's id; blank is Auto. */
  model: string
  /** Blank is the model's default. */
  effort: ReasoningEffort | ''
  /** With Auto, what it optimizes for; blank is Copilot's default. */
  autoTier: string
  /** With a model that offers several, its context window; blank is the standard one. */
  contextTier: ContextTier | ''
}

export const AUTO_SELECTION: ModelSelection = {
  model: '',
  effort: '',
  autoTier: '',
  contextTier: ''
}

/** A saved choice as a selection, keeping only the parts that apply to it: on
 *  Auto, Copilot also decides the effort; a model has no Auto tier. */
export function selectionOf(saved: {
  model?: string
  effort?: ReasoningEffort | ''
  autoTier?: string
  contextTier?: ContextTier | ''
}): ModelSelection {
  const model = saved.model?.trim() === 'auto' ? '' : (saved.model?.trim() ?? '')
  return model
    ? { model, effort: saved.effort ?? '', autoTier: '', contextTier: saved.contextTier ?? '' }
    : { ...AUTO_SELECTION, autoTier: saved.autoTier ?? '' }
}

/** A selection as command arguments, blank parts left out. */
export function selectionArgs(s: ModelSelection): {
  model?: string
  effort?: ReasoningEffort
  autoTier?: string
  contextTier?: ContextTier
} {
  return {
    model: s.model.trim() || undefined,
    effort: s.effort || undefined,
    autoTier: s.autoTier || undefined,
    contextTier: s.contextTier || undefined
  }
}

/** A selection kept on this computer under `key`; Auto when there's none. */
export function readStoredSelection(key: string): ModelSelection {
  try {
    const raw = localStorage.getItem(key)
    const saved = raw ? (JSON.parse(raw) as Record<string, unknown>) : null
    if (!saved || typeof saved !== 'object') return AUTO_SELECTION
    const text = (v: unknown): string => (typeof v === 'string' ? v : '')
    return selectionOf({
      model: text(saved.model),
      effort: text(saved.effort) as ReasoningEffort | '',
      autoTier: text(saved.autoTier),
      contextTier: text(saved.contextTier) as ContextTier | ''
    })
  } catch {
    return AUTO_SELECTION
  }
}

export function writeStoredSelection(key: string, s: ModelSelection): void {
  try {
    if (s.model || s.autoTier) localStorage.setItem(key, JSON.stringify(s))
    else localStorage.removeItem(key)
  } catch {
    /* storage unavailable — keep the in-memory choice */
  }
}
