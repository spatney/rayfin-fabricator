import { describe, expect, it } from 'vitest'
import {
  classifyFabricAppsRegion,
  fabricAppsRegionWarning,
  FABRIC_REGION_AVAILABILITY_DOC,
  fabricWorkspaceUrl,
} from './fabric'

/**
 * The footer workspace link deep-links to the Fabric portal using the workspace
 * GUID recorded in the deployment file (`fabricWorkspaceId`). Guards the exact
 * `groups/{id}/` URL shape and the GUID-only guard that keeps a pre-reconcile
 * display name from producing a broken link.
 */
describe('fabricWorkspaceUrl', () => {
  it('builds a Fabric portal groups deep link from a workspace GUID', () => {
    expect(fabricWorkspaceUrl('de0fcf1a-8c94-46cf-a029-650b2e87f172')).toBe(
      'https://app.fabric.microsoft.com/groups/de0fcf1a-8c94-46cf-a029-650b2e87f172/'
    )
  })

  it('is case-insensitive and trims surrounding whitespace', () => {
    expect(fabricWorkspaceUrl('  DE0FCF1A-8C94-46CF-A029-650B2E87F172  ')).toBe(
      'https://app.fabric.microsoft.com/groups/DE0FCF1A-8C94-46CF-A029-650B2E87F172/'
    )
  })

  it('returns undefined for a non-GUID workspace (e.g. a display name)', () => {
    expect(fabricWorkspaceUrl('Rayfin Apps')).toBeUndefined()
  })

  it('returns undefined when the id is missing or empty', () => {
    expect(fabricWorkspaceUrl(undefined)).toBeUndefined()
    expect(fabricWorkspaceUrl('')).toBeUndefined()
    expect(fabricWorkspaceUrl('   ')).toBeUndefined()
  })
})

/**
 * Fabric Apps (preview) is unavailable in some regions. `classifyFabricAppsRegion`
 * reads the maintained JSON list and is fail-open (unknown regions never block),
 * and `fabricAppsRegionWarning` points users at the live docs since availability
 * changes over time. Real tenant regions are used: West US 3 (unsupported) and
 * France Central (supported).
 */
describe('classifyFabricAppsRegion', () => {
  it('flags a region listed as unsupported', () => {
    expect(classifyFabricAppsRegion('West US 3')).toBe('unsupported')
  })

  it('is case- and whitespace-insensitive', () => {
    expect(classifyFabricAppsRegion('  west us 3 ')).toBe('unsupported')
  })

  it('treats a region not in the list as supported', () => {
    expect(classifyFabricAppsRegion('France Central')).toBe('supported')
  })

  it('fails open on a missing region', () => {
    expect(classifyFabricAppsRegion(undefined)).toBe('unknown')
    expect(classifyFabricAppsRegion('')).toBe('unknown')
  })
})

describe('fabricAppsRegionWarning', () => {
  it('warns and advises checking the docs for an unsupported region', () => {
    const msg = fabricAppsRegionWarning('West US 3')
    expect(msg).toContain('West US 3')
    expect(msg).toContain('documentation')
  })

  it('returns undefined for supported or unknown regions', () => {
    expect(fabricAppsRegionWarning('France Central')).toBeUndefined()
    expect(fabricAppsRegionWarning(undefined)).toBeUndefined()
  })
})

describe('FABRIC_REGION_AVAILABILITY_DOC', () => {
  it('points to the Fabric region-availability matrix', () => {
    expect(FABRIC_REGION_AVAILABILITY_DOC).toContain('region-availability')
  })
})
