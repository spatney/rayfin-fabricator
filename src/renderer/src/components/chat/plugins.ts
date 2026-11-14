import type { ChatPluginId, ExperimentFlags } from '@shared/ipc'
import fabricSvg from '../../assets/brands/fabric.svg'
import microsoftSvg from '../../assets/brands/microsoft.svg'
import { translator } from '../../i18n'

/** A plugin chat can look things up with, as the composer's Plugins menu shows it. */
export interface ChatPlugin {
  id: Exclude<ChatPluginId, `mcp:${string}`>
  name: string
  /** What it looks up. */
  description: string
  logo: string
  /** Offered only while this experiment is on. */
  experiment?: keyof ExperimentFlags
}

export const CHAT_PLUGINS: readonly ChatPlugin[] = [
  {
    id: 'fabric-iq',
    name: 'Fabric IQ',
    get description() {
      return translator('chat')('plugins.fabricIq')
    },
    logo: fabricSvg
  },
  {
    id: 'work-iq',
    name: 'Work IQ',
    get description() {
      return translator('chat')('plugins.workIq')
    },
    logo: microsoftSvg,
    experiment: 'workIq'
  }
]

/** The plugins chat offers with `experiments` on. */
export function offeredPlugins(experiments?: ExperimentFlags | null): ChatPlugin[] {
  return CHAT_PLUGINS.filter((p) => !p.experiment || Boolean(experiments?.[p.experiment]))
}

/** The plugin id of an MCP server you added. */
export function mcpPluginId(serverId: string): ChatPluginId {
  return `mcp:${serverId}`
}
