import { describe, expect, it } from 'vitest'
import type { RayfinNewerRelease, RayfinVersionInfo } from '@shared/ipc'
import {
  newerRayfin,
  newerRayfinWarnings,
  publishesAfterTurn,
  recommendedUpdates
} from './localDevelopment'

describe('publishing after each chat turn', () => {
  it('is off until the user turns it on', () => {
    expect(publishesAfterTurn(null)).toBe(false)
    expect(publishesAfterTurn({ theme: 'system' })).toBe(false)
    expect(publishesAfterTurn({ theme: 'system', deployMode: 'manual' })).toBe(false)
    expect(publishesAfterTurn({ theme: 'system', deployMode: 'auto' })).toBe(true)
  })
})

describe('Rayfin updates of an app', () => {
  const versions = (
    installed: string,
    latest: string,
    recommended?: string,
    newer?: RayfinNewerRelease
  ): RayfinVersionInfo => ({
    version: installed,
    latest,
    upgradeAvailable: installed !== latest,
    recommended,
    newer,
    packages: [
      { name: '@microsoft/rayfin-cli', kind: 'cli', installed, latest, upgradable: true },
      { name: '@microsoft/rayfin-core', kind: 'sdk', installed, latest, upgradable: true }
    ]
  })
  const preview: RayfinNewerRelease = { version: '2.0.0', isLatest: false, runsLocally: true }

  it('go to the release Fabricator recommends', () => {
    const offered = recommendedUpdates(versions('1.36.0', '1.37.1', '1.36.2'))
    expect(offered.latest).toBe('1.36.2')
    expect(offered.upgradeAvailable).toBe(true)
    expect(offered.packages.map((p) => [p.latest, p.upgradable])).toEqual([
      ['1.36.2', true],
      ['1.36.2', true]
    ])
  })

  it('offer nothing once the app is there, or past it, or while it isn’t known', () => {
    for (const info of [
      versions('1.36.2', '1.37.1', '1.36.2'),
      versions('2.0.0', '1.36.2', '1.36.2'),
      versions('1.36.0', '1.37.1')
    ]) {
      const offered = recommendedUpdates(info)
      expect(offered.upgradeAvailable).toBe(false)
      expect(offered.packages.some((p) => p.upgradable)).toBe(false)
    }
  })

  it('offer a newer release, such as a preview, with why it needs care', () => {
    expect(newerRayfin(versions('1.36.2', '1.36.2', '1.36.2', preview))).toEqual(preview)
    expect(newerRayfin(versions('1.36.0', '1.36.2', '1.36.2', preview))).toEqual(preview)
    // Not once the app is on it or past it, nor before its packages are installed.
    expect(newerRayfin(versions('2.0.0', '1.36.2', '1.36.2', preview))).toBeNull()
    expect(newerRayfin(versions('2.1.0', '1.36.2', '1.36.2', preview))).toBeNull()
    expect(
      newerRayfin({ ...versions('1.36.2', '1.36.2'), newer: preview, version: null })
    ).toBeNull()

    expect(newerRayfinWarnings(preview)).toEqual([
      'It isn’t Rayfin’s latest release yet, so it might be unstable.'
    ])
    expect(newerRayfinWarnings({ version: '2.1.0', isLatest: true, runsLocally: false })).toEqual([
      'Fabricator doesn’t run it on this computer yet, so some things might not work as expected here.'
    ])
  })
})
