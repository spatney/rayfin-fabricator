import { useEffect, useState } from 'react'
import type { StudioProject, Suggestion } from '@shared/ipc'

/** Words to drop when guessing what an app is "about" from its name. */
export const STOP_WORDS = new Set([
  'app',
  'apps',
  'application',
  'my',
  'the',
  'a',
  'an',
  'rayfin',
  'fabric',
  'fabricator',
  'demo',
  'test',
  'sample',
  'project',
  'tracker',
  'manager',
  'management',
  'hub',
  'board',
  'tool',
  'studio',
  'dashboard',
  'system',
  'portal',
  'keeper',
  'book',
  'box',
  'list',
  'log',
  'mate',
  'buddy',
  'pro',
  'plus',
  'lite'
])

/** Naive English pluralization — good enough for friendly UI copy. */
export function pluralize(w: string): string {
  if (!w) return w
  if (w.endsWith('s')) return w
  if (/[^aeiou]y$/i.test(w)) return `${w.slice(0, -1)}ies`
  if (/(x|z|ch|sh)$/i.test(w)) return `${w}es`
  return `${w}s`
}

/** Naive singularization paired with {@link pluralize}. */
export function singularize(w: string): string {
  if (w.endsWith('ies')) return `${w.slice(0, -3)}y`
  if (w.endsWith('ses')) return w.slice(0, -2)
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1)
  return w
}

/**
 * Guess the "thing" an app manages from its name + template, so starter prompts
 * can be tailored ("Show all your plants" for a Plant Tracker). Falls back to a
 * sensible generic noun by template.
 */
export function deriveThings(project: StudioProject): { thing: string; things: string } {
  const tpl = (project.template ?? '').toLowerCase()
  const words = (project.name ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((w) => !STOP_WORDS.has(w) && !/^\d+$/.test(w))
  let base = words.length ? words[words.length - 1] : ''
  if (!base || base.length < 2) {
    base = tpl.includes('todo') ? 'task' : tpl.includes('data') ? 'record' : 'item'
  }
  return { thing: singularize(base), things: pluralize(base) }
}

/**
 * Build the empty-state starter prompts. These intentionally only cover what
 * Rayfin natively provides — data (lists/forms/search/charts), authentication,
 * file storage and design — never anything needing an external service (e.g.
 * payments or email).
 */
export function suggestionsFor(project: StudioProject): Suggestion[] {
  const { thing, things } = deriveThings(project)
  const cards = {
    list: { icon: '📋', text: `Show all my ${things} on a clean page` },
    create: { icon: '✏️', text: `Add a form to create and edit a ${thing}` },
    search: { icon: '🔍', text: `Add search and filters to my ${things}` },
    chart: { icon: '📊', text: `Add a dashboard that charts my ${things}` },
    auth: { icon: '🔒', text: `Require sign-in so everyone gets their own ${things}` },
    photo: { icon: '🖼️', text: `Let me attach a photo to each ${thing}` },
    design: { icon: '🎨', text: 'Give the whole app a fresh, modern look' }
  }
  const tpl = (project.template ?? '').toLowerCase()
  let order: (keyof typeof cards)[]
  if (tpl.includes('auth')) order = ['auth', 'list', 'create', 'design']
  else if (tpl.includes('todo')) order = ['list', 'create', 'auth', 'design']
  else if (tpl.includes('data')) order = ['list', 'search', 'chart', 'create']
  else order = ['list', 'create', 'chart', 'design']
  return order.map((k) => cards[k])
}

/**
 * Ask Copilot for starter suggestions grounded in the project's actual code. The
 * backend caches per project (reused until the code changes), so this is cheap to
 * call whenever the empty Build chat is shown. The welcome screen shows the
 * instant heuristic suggestions right away and only swaps in this generated set
 * once it arrives, so `loading` never blocks the UI — it just drives a subtle
 * "Tailoring ideas…" hint. On any failure/timeout the heuristic fallback simply
 * stays. The in-flight request is cancelled when the empty state goes away (e.g.
 * the user sends a message) so it never competes with a real turn.
 */
export function useGeneratedSuggestions(
  projectId: string,
  enabled: boolean
): { suggestions: Suggestion[] | null; loading: boolean; failed: boolean; refresh: () => void } {
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null)
  // Start in the loading state when enabled so the skeletons show immediately,
  // rather than flashing the heuristic fallback for a frame before the effect runs.
  const [loading, setLoading] = useState(enabled)
  const [failed, setFailed] = useState(false)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    setLoading(true)
    setFailed(false)
    // A forced refresh should regenerate even if the code is unchanged.
    const p =
      nonce > 0
        ? window.api.chat.cancelSuggest(projectId).catch(() => false)
        : Promise.resolve(false)
    void p.then(() =>
      window.api.chat
        .suggest(projectId)
        .then((set) => {
          if (cancelled) return
          if (set.ok && set.suggestions.length > 0) {
            setSuggestions(set.suggestions)
          } else {
            setFailed(true)
          }
        })
        .catch(() => {
          if (!cancelled) setFailed(true)
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    )
    return () => {
      cancelled = true
      // Stop any in-flight generation so it doesn't run alongside a real turn.
      void window.api.chat.cancelSuggest(projectId).catch(() => undefined)
    }
  }, [projectId, enabled, nonce])

  const refresh = (): void => {
    setSuggestions(null)
    setNonce((n) => n + 1)
  }

  return { suggestions, loading, failed, refresh }
}
