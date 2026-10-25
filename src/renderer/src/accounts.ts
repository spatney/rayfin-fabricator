import type { AuthStatus } from '@shared/ipc'

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Something that knows a tenant's directory name, e.g. an Azure CLI account. */
interface KnownTenant {
  tenant?: string
  tenantName?: string
}

/** A Microsoft Entra tenant's directory name, from any account that knows it. */
export function tenantName(
  tenant: string | undefined,
  ...known: Array<KnownTenant | undefined>
): string | undefined {
  const id = tenant?.trim().toLowerCase()
  if (!id) return undefined
  return known.find((k) => k?.tenantName && k.tenant?.trim().toLowerCase() === id)?.tenantName
}

/**
 * A readable name for a Microsoft Entra tenant: its directory name when an
 * Azure CLI account in it knows it, otherwise a shortened id.
 */
export function tenantLabel(
  tenant: string | undefined,
  ...known: Array<KnownTenant | undefined>
): string | undefined {
  const id = tenant?.trim()
  if (!id) return undefined
  return tenantName(id, ...known) ?? (GUID.test(id) ? `Tenant ${id.slice(0, 8)}…` : id)
}

/** Fabric and the Azure CLI are both signed in, to different tenants. */
export function tenantsDiffer(auth: AuthStatus): boolean {
  const fabric = auth.rayfin.signedIn ? auth.rayfin.tenant?.trim().toLowerCase() : undefined
  const azure = auth.az.signedIn ? auth.az.tenant?.trim().toLowerCase() : undefined
  return Boolean(fabric && azure && fabric !== azure)
}

const CODE = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/g
/** GitHub's device page on github.com or a GitHub Enterprise Cloud (`*.ghe.com`) host. */
const DEVICE_URL = /(?:https:\/\/)?(?:[a-z0-9-]+\.)*(?:github|ghe)\.com\/login\/device\b/gi

/**
 * The one-time code (and where to enter it) from a device-code sign-in's
 * output — the latest of each, since a retried sign-in prints a new code. Only
 * lines that talk about a code or the device page count, so ids elsewhere in
 * the output aren't mistaken for one.
 */
export function deviceCode(log: string): { code?: string; url?: string } {
  const relevant = log
    .split(/\r?\n/)
    .filter((line) => /code|login\/device/i.test(line))
    .join('\n')
  const code = [...relevant.matchAll(CODE)].pop()?.[1]
  const found = [...relevant.matchAll(DEVICE_URL)].pop()?.[0]
  const url = found && (found.startsWith('https://') ? found : `https://${found}`)
  return { code, url }
}
