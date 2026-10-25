import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FabricWorkspace } from '@shared/ipc'
import {
  connectDataContext,
  connectedFromWorkspaces,
  connectedItemIds,
  dataTurnPrompt,
  recentDataWorkspaces,
  rememberConnectedFrom,
  type DataSource
} from './fabricData'

const source = (workspaceName: string, workspaceId: string, id: string, name: string, type: string): DataSource => ({
  workspaceId,
  workspaceName,
  item: { id, name, type: type as DataSource['item']['type'] }
})

const ws = (id: string, displayName: string): FabricWorkspace => ({ id, displayName, capacityKind: 'fabric', eligible: true })

beforeEach(() => localStorage.clear())
afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

describe('the prompt for a message sent with Fabric data', () => {
  it('puts the message first, then how to connect the data', () => {
    const prompt = dataTurnPrompt('Chart sales by region', [source('Finance', 'ws-fin', 'm1', 'Sales', 'SemanticModel')])
    expect(prompt).toMatch(
      /^Chart sales by region\n\n\[Fabricator: the user added this Fabric data to the message\. Connect it to the app as a Rayfin connector, then use it for the request above\.\]\n/
    )
    expect(prompt).toContain(
      '- Semantic model "Sales" from the "Finance" workspace:\n  npx rayfin connector add --type fabric-semanticmodel --workspace-id ws-fin --item-id m1'
    )
    expect(prompt).toContain('run the version-pinned npm install command it prints')
    expect(prompt).toContain('fabric-app-data')
    expect(prompt).not.toContain('metadata.json')
  })

  it('lists data from several workspaces, each with its connector type, and asks for a connection when the message is empty', () => {
    const sources = [
      source('Ops', 'ws-ops', 'w1', 'Inventory', 'Warehouse'),
      source('Ops', 'ws-ops', 'd1', 'crm', 'SQLDatabase'),
      source('Lake\nside', 'ws-lake', 'l1', 'orders', 'Lakehouse')
    ]
    const context = connectDataContext(sources)
    expect(context).toContain('these Fabric data sources')
    expect(context).toContain('--type fabric-warehouse --workspace-id ws-ops --item-id w1')
    expect(context).toContain('--type fabric-sqldatabase --workspace-id ws-ops --item-id d1')
    expect(context).toContain(
      '- Lakehouse "orders" from the "Lake side" workspace (read-only):\n  npx rayfin connector add --type fabric-sqlanalytics --workspace-id ws-lake --item-id l1'
    )
    expect(context).toContain('metadata.json')
    expect(context).not.toContain('fabric-app-data')
    expect(dataTurnPrompt('  ', sources)).toMatch(/^Connect these data sources to the app, and tell me what I could build with them\.\n\n\[Fabricator:/)
  })
})

describe('recent data workspaces', () => {
  it('merges deploys and connected-from workspaces, newest first, among the workspaces you can open', () => {
    rememberConnectedFrom(['WS-FIN'], 3_000)
    rememberConnectedFrom(['ws-gone', 'ws-ops'], 1_000)
    // Connecting again moves a workspace to the front without repeating it.
    rememberConnectedFrom(['ws-fin'], 5_000)
    expect(connectedFromWorkspaces().map((u) => u.id)).toEqual(['ws-fin', 'ws-gone', 'ws-ops'])

    const all = [ws('ws-app', 'App WS'), ws('ws-fin', 'Finance'), ws('ws-ops', 'Ops'), ws('ws-z', 'Zeta')]
    const recent = recentDataWorkspaces(all, [{ workspace: 'App WS', at: 4_000 }], connectedFromWorkspaces())
    expect(recent.map((w) => w.displayName)).toEqual(['Finance', 'App WS', 'Ops'])
    expect(recentDataWorkspaces(all, [], connectedFromWorkspaces(), 1).map((w) => w.id)).toEqual(['ws-fin'])
  })
})

describe('connectedItemIds', () => {
  it('collects the Rayfin connectors and fabric.yaml semantic models the project has', async () => {
    const yml = [
      'services:',
      '  data:',
      '    enabled: true',
      'connectors:',
      '  - name: inventory',
      '    type: fabric-warehouse',
      '    config:',
      '      workspaceId: ws-ops',
      '      itemId: W1',
      ''
    ].join('\n')
    ;(window as unknown as { api: unknown }).api = {
      projects: {
        files: {
          read: vi.fn(async (_id: string, path: string) =>
            path === 'rayfin/rayfin.yml' ? { content: yml } : { error: 'not found' }
          )
        }
      },
      fabric: { projectSemanticModels: vi.fn(async () => [{ alias: 'sales', workspaceId: 'ws-fin', itemId: 'm1' }]) }
    }
    expect([...(await connectedItemIds('p1'))].sort()).toEqual(['m1', 'w1'])
  })
})
