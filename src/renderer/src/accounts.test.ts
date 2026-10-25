import { describe, expect, it } from 'vitest'
import type { AuthStatus } from '@shared/ipc'
import { deviceCode, tenantLabel, tenantsDiffer } from './accounts'

const CONTOSO = '72f988bf-86f1-41af-91ab-2d7cd011db47'
const FABRIKAM = 'aaaaaaaa-0000-0000-0000-000000000000'

describe('tenantLabel', () => {
  it('names the tenant when the Azure CLI knows it, else shortens its id', () => {
    const az = { signedIn: true, tenant: CONTOSO.toUpperCase(), tenantName: 'Contoso' }
    expect(tenantLabel(CONTOSO, az)).toBe('Contoso')
    expect(tenantLabel(FABRIKAM, az)).toBe('Tenant aaaaaaaa…')
    expect(tenantLabel('contoso.onmicrosoft.com')).toBe('contoso.onmicrosoft.com')
    expect(tenantLabel('  ')).toBeUndefined()
    expect(tenantLabel(undefined)).toBeUndefined()
  })

  it('names it from any Azure CLI account in that tenant, not only the one in use', () => {
    const az = { signedIn: true, tenant: CONTOSO, tenantName: 'Contoso' }
    const accounts = [{ tenant: FABRIKAM.toUpperCase(), tenantName: 'Fabrikam' }]
    expect(tenantLabel(FABRIKAM, az, ...accounts)).toBe('Fabrikam')
  })
})

describe('tenantsDiffer', () => {
  const auth = (fabric?: string, azure?: string): AuthStatus => ({
    copilot: { signedIn: true },
    rayfin: { signedIn: Boolean(fabric), tenant: fabric },
    az: { signedIn: Boolean(azure), tenant: azure }
  })

  it('flags Fabric and the Azure CLI signed in to different tenants', () => {
    expect(tenantsDiffer(auth(CONTOSO, FABRIKAM))).toBe(true)
    expect(tenantsDiffer(auth(CONTOSO, CONTOSO.toUpperCase()))).toBe(false)
    expect(tenantsDiffer(auth(CONTOSO, undefined))).toBe(false)
    expect(tenantsDiffer(auth(undefined, FABRIKAM))).toBe(false)
  })
})

describe('deviceCode', () => {
  it('finds the latest one-time code and GitHub device page', () => {
    expect(deviceCode('Enter ABCD-EFGH at github.com/login/device')).toEqual({
      code: 'ABCD-EFGH',
      url: 'https://github.com/login/device'
    })
    expect(
      deviceCode(
        'First copy your one-time code: AAAA-1111\nTry again\nOpen https://company.ghe.com/login/device and enter code BBBB-2222\n'
      )
    ).toEqual({ code: 'BBBB-2222', url: 'https://company.ghe.com/login/device' })
  })

  it('ignores lookalikes outside lines about a code', () => {
    expect(deviceCode('Session 2026-1003 started\nWaiting for authorization…')).toEqual({
      code: undefined,
      url: undefined
    })
    expect(
      deviceCode('Visit https://evil.example/login/device to enter code ABCD-1234').url
    ).toBeUndefined()
  })
})
