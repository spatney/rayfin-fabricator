/**
 * Read a Fabric data-app's `fabric.yaml` to discover which Power BI / Fabric
 * **semantic model(s)** the project is connected to. This is the design-time
 * counterpart to the app's runtime `fabric.generated.ts` — the Model tab uses it
 * to know a project has a semantic model (so it can offer the semantic diagram)
 * and to get the `workspaceId` / `itemId` needed to query the model's schema.
 *
 * `fabric.yaml` shape (for a Fabric-connected app):
 *
 *   activeProfile: default
 *   profiles:
 *     default:
 *       semanticModels:
 *         model:
 *           workspaceId: <guid>
 *           itemId: <guid>
 */

import { parse as parseYaml } from 'yaml'

/** One semantic-model connection declared under a profile's `semanticModels`. */
export interface SemanticModelRef {
  /** The alias key under `semanticModels` (e.g. "model"). */
  alias: string
  workspaceId: string
  itemId: string
}

export interface FabricConfig {
  /** The selected profile (`activeProfile`, defaulting to "default"). */
  activeProfile: string
  /** The active profile's semantic-model connections (may be empty). */
  models: SemanticModelRef[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Parse `fabric.yaml` text into the active profile's semantic models. Returns
 * `null` when the text isn't valid YAML or has no `profiles` map; returns a
 * config with an empty `models` array when the profile simply declares none.
 */
export function parseFabricConfig(text: string): FabricConfig | null {
  let doc: unknown
  try {
    doc = parseYaml(text)
  } catch {
    return null
  }
  const root = asRecord(doc)
  if (!root) return null

  const activeProfile =
    typeof root.activeProfile === 'string' && root.activeProfile.trim()
      ? root.activeProfile.trim()
      : 'default'

  const profiles = asRecord(root.profiles)
  if (!profiles) return null

  const profile = asRecord(profiles[activeProfile])
  const semanticModels = profile ? asRecord(profile.semanticModels) : null

  const models: SemanticModelRef[] = []
  if (semanticModels) {
    for (const [alias, raw] of Object.entries(semanticModels)) {
      const entry = asRecord(raw)
      const workspaceId = typeof entry?.workspaceId === 'string' ? entry.workspaceId.trim() : ''
      const itemId = typeof entry?.itemId === 'string' ? entry.itemId.trim() : ''
      if (workspaceId && itemId) models.push({ alias, workspaceId, itemId })
    }
  }

  return { activeProfile, models }
}

/**
 * Read + parse a project's `fabric.yaml`. Resolves to `null` when the file is
 * absent, unreadable, binary/too-large, or not valid — callers treat that as
 * "this project has no semantic model".
 */
export async function loadProjectFabricConfig(projectId: string): Promise<FabricConfig | null> {
  try {
    const fc = await window.api.projects.files.read(projectId, 'fabric.yaml')
    if (fc.error || fc.binary || fc.tooLarge || !fc.content) return null
    return parseFabricConfig(fc.content)
  } catch {
    return null
  }
}
