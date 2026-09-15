import { describe, expect, it } from 'vitest'
import { parseFabricConfig } from './fabricConfig'

const YAML = `
activeProfile: default
profiles:
  default:
    semanticModels:
      model:
        workspaceId: ea3779f7-4d16-4fbc-87ba-f501e2a6fdee
        itemId: 92a63060-dcef-4d6b-ac2f-cdd1bae79b43
`

describe('parseFabricConfig', () => {
  it('reads the active profile and its semantic model', () => {
    const cfg = parseFabricConfig(YAML)
    expect(cfg).not.toBeNull()
    expect(cfg?.activeProfile).toBe('default')
    expect(cfg?.models).toEqual([
      {
        alias: 'model',
        workspaceId: 'ea3779f7-4d16-4fbc-87ba-f501e2a6fdee',
        itemId: '92a63060-dcef-4d6b-ac2f-cdd1bae79b43'
      }
    ])
  })

  it('follows activeProfile to a non-default profile', () => {
    const cfg = parseFabricConfig(`
activeProfile: prod
profiles:
  default:
    semanticModels:
      dev:
        workspaceId: dev-ws
        itemId: dev-item
  prod:
    semanticModels:
      main:
        workspaceId: prod-ws
        itemId: prod-item
`)
    expect(cfg?.activeProfile).toBe('prod')
    expect(cfg?.models).toEqual([{ alias: 'main', workspaceId: 'prod-ws', itemId: 'prod-item' }])
  })

  it('surfaces multiple models under one profile', () => {
    const cfg = parseFabricConfig(`
activeProfile: default
profiles:
  default:
    semanticModels:
      sales:
        workspaceId: ws1
        itemId: item1
      finance:
        workspaceId: ws2
        itemId: item2
`)
    expect(cfg?.models).toHaveLength(2)
    expect(cfg?.models.map((m) => m.alias)).toEqual(['sales', 'finance'])
  })

  it('defaults activeProfile to "default" when absent', () => {
    const cfg = parseFabricConfig(`
profiles:
  default:
    semanticModels:
      model:
        workspaceId: ws
        itemId: item
`)
    expect(cfg?.activeProfile).toBe('default')
    expect(cfg?.models).toHaveLength(1)
  })

  it('returns an empty model list when the profile declares none', () => {
    const cfg = parseFabricConfig(`
activeProfile: default
profiles:
  default: {}
`)
    expect(cfg).not.toBeNull()
    expect(cfg?.models).toEqual([])
  })

  it('skips models missing a workspaceId or itemId', () => {
    const cfg = parseFabricConfig(`
activeProfile: default
profiles:
  default:
    semanticModels:
      broken:
        workspaceId: ws-only
      ok:
        workspaceId: ws
        itemId: item
`)
    expect(cfg?.models).toEqual([{ alias: 'ok', workspaceId: 'ws', itemId: 'item' }])
  })

  it('returns null when there is no profiles map', () => {
    expect(parseFabricConfig('activeProfile: default')).toBeNull()
  })

  it('returns null on invalid YAML', () => {
    expect(parseFabricConfig(': : : not yaml : :')).toBeNull()
  })
})
