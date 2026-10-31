import { useEffect, useSyncExternalStore } from 'react'
import type { McpServer } from '@shared/ipc'

// The MCP servers you added (MCP servers experiment), shared by every chat's
// Plugins menu and the MCP servers dialog, and read once.
let cache: McpServer[] | null = null
let pending: Promise<McpServer[]> | null = null
let generation = 0
const listeners = new Set<() => void>()
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const snapshot = (): McpServer[] | null => cache
const NONE: McpServer[] = []

/** Keep `servers` as the list everyone sees, e.g. after a save or a removal. */
export function setMcpServers(servers: McpServer[]): void {
  generation += 1
  cache = servers
  pending = null
  listeners.forEach((listener) => listener())
}

/** Forget the list, so it's read again. */
export function invalidateMcpServers(): void {
  generation += 1
  cache = null
  pending = null
  listeners.forEach((listener) => listener())
}

export function loadMcpServers(): Promise<McpServer[]> {
  if (cache) return Promise.resolve(cache)
  if (!pending) {
    const current = generation
    pending = window.api.mcp.list().then(
      (servers) => {
        if (current === generation) setMcpServers(servers)
        return servers
      },
      (reason) => {
        if (current === generation) pending = null
        throw reason
      }
    )
  }
  return pending
}

/** The MCP servers you added, while `enabled` (the experiment is on). */
export function useMcpServers(enabled: boolean): McpServer[] {
  const servers = useSyncExternalStore(subscribe, snapshot)
  useEffect(() => {
    if (enabled && !servers) {
      loadMcpServers().catch((reason) => console.warn('Could not load your MCP servers', reason))
    }
  }, [enabled, servers])
  return enabled && servers ? servers : NONE
}
