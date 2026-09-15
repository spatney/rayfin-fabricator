import type { SemanticModel } from './semanticModel'

/**
 * Session-lived cache of built semantic models, keyed by `workspaceId::itemId`.
 *
 * Reading a semantic model's schema is an expensive live Fabric query (a Node
 * helper spawns per call). The Model tab remounts the view when toggling between
 * the Data and Semantic models, and the parent may re-render it, so without a
 * cache every visit would re-query Fabric. This module-level map persists across
 * mounts for the lifetime of the session; an explicit Refresh bypasses it.
 */
const cache = new Map<string, SemanticModel>()

/** Cache key for a semantic model reference. */
export function schemaCacheKey(workspaceId: string, itemId: string): string {
  return `${workspaceId}::${itemId}`
}

/** Returns the cached model for a key, or `undefined` when not cached. */
export function getCachedSchema(key: string): SemanticModel | undefined {
  return cache.get(key)
}

/** Stores a freshly built model under a key. */
export function setCachedSchema(key: string, model: SemanticModel): void {
  cache.set(key, model)
}

/** A failed live read must not become a cached success when the view remounts. */
export function invalidateCachedSchema(key: string): void {
  cache.delete(key)
}

/** Clears the whole cache. Intended for tests. */
export function clearSchemaCache(): void {
  cache.clear()
}
