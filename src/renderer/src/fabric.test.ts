import { describe, expect, it } from 'vitest'
import { fabricWorkspaceUrl } from './fabric'

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
