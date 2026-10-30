import type { LocalSecret, SecretInfo, SecretsState } from '@shared/ipc'

/** The description `rayfin secret set` records when it's given none. */
const DESCRIPTION_PLACEHOLDER = 'TODO: Add description for this secret'

/** Where a secret's value on this computer comes from (rayfin-local's `source`). */
export type LocalSource = LocalSecret['source']

/**
 * One secret of a personal app: its entry in `rayfin.yml`, its value on this
 * computer and its value on the published app. Never a value itself.
 */
export interface SecretEntry {
  name: string
  description?: string
  /** Listed under `secrets:` in `rayfin.yml`, so functions get it. */
  declared: boolean
  /** Where its value on this computer comes from; absent while that isn't known. */
  local?: LocalSource
  /** The published app's view of it; absent unless the published values were read. */
  published?: SecretInfo
}

/**
 * The ones functions get first, then the others. Each by name, like
 * `secrets_list`: case-insensitively, then exactly.
 */
function inOrder(a: SecretEntry, b: SecretEntry): number {
  if (a.declared !== b.declared) return a.declared ? -1 : 1
  const [x, y] = [a.name.toLowerCase(), b.name.toLowerCase()]
  if (x !== y) return x < y ? -1 : 1
  return a.name === b.name ? 0 : a.name < b.name ? -1 : 1
}

/**
 * The secrets of a personal app: the ones `secrets_list` reports (declared, or
 * stored on the published app) and the ones rayfin-local has a value for.
 * `local` is `null` while the local values aren't known.
 */
export function secretEntries(state: SecretsState, local: LocalSecret[] | null): SecretEntry[] {
  const published = state.status === 'ready'
  const entries = new Map<string, SecretEntry>()
  for (const secret of state.secrets) {
    entries.set(secret.name, {
      name: secret.name,
      description: secret.description,
      declared: secret.declared,
      published: published ? secret : undefined
    })
  }
  for (const value of local ?? []) {
    const text = value.description?.trim()
    const description = text && text !== DESCRIPTION_PLACEHOLDER ? text : undefined
    const entry = entries.get(value.name)
    if (entry) {
      entry.local = value.source
      entry.declared = entry.declared || value.declared
      if (!entry.description) entry.description = description
    } else {
      entries.set(value.name, {
        name: value.name,
        description,
        declared: value.declared,
        local: value.source
      })
    }
  }
  if (local) for (const entry of entries.values()) if (!entry.local) entry.local = 'none'
  return [...entries.values()].sort(inOrder)
}
