import { describe, expect, it } from 'vitest'
import type { AppSettings, RayfinVersionInfo } from '@shared/ipc'
import { publishesAfterTurn, upgradesWithinLocalRange } from './localDevelopment'

describe('publishing after each chat turn', () => {
  const off: AppSettings = { theme: 'system' }
  const on: AppSettings = { theme: 'system', experiments: { localDevelopment: true } }

  it('follows Local development until the user chooses: on without it, off with it', () => {
    expect(publishesAfterTurn(null)).toBe(true)
    expect(publishesAfterTurn(off)).toBe(true)
    expect(publishesAfterTurn({ ...off, experiments: { localDevelopment: false } })).toBe(true)
    expect(publishesAfterTurn(on)).toBe(false)
  })

  it('does what the user chose in either mode', () => {
    for (const settings of [off, on]) {
      expect(publishesAfterTurn({ ...settings, deployMode: 'auto' })).toBe(true)
      expect(publishesAfterTurn({ ...settings, deployMode: 'manual' })).toBe(false)
    }
  })
})

describe('Rayfin upgrades with Local development', () => {
  const versions = (
    installed: string,
    latest: string,
    latestSupportedLocally?: string
  ): RayfinVersionInfo => ({
    version: installed,
    latest,
    upgradeAvailable: installed !== latest,
    latestSupportedLocally,
    packages: [
      { name: '@microsoft/rayfin-cli', kind: 'cli', installed, latest, upgradable: true },
      { name: '@microsoft/rayfin-core', kind: 'sdk', installed, latest, upgradable: true }
    ]
  })

  it('stop at the newest release the local backend runs', () => {
    const capped = upgradesWithinLocalRange(versions('1.36.0', '1.37.1', '1.36.2'))
    expect(capped.latest).toBe('1.36.2')
    expect(capped.upgradeAvailable).toBe(true)
    expect(capped.packages.map((p) => [p.latest, p.upgradable])).toEqual([
      ['1.36.2', true],
      ['1.36.2', true]
    ])
  })

  it('offer nothing once the app is there, or past it, or while it isn’t known', () => {
    for (const info of [
      versions('1.36.2', '1.37.1', '1.36.2'),
      versions('1.37.0', '1.37.1', '1.36.2'),
      versions('1.36.0', '1.37.1')
    ]) {
      const capped = upgradesWithinLocalRange(info)
      expect(capped.upgradeAvailable).toBe(false)
      expect(capped.packages.some((p) => p.upgradable)).toBe(false)
    }
  })
})
