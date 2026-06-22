/**
 * Anonymous, hashed usage telemetry.
 *
 * The app sends two tiny custom events to Azure Application Insights — `signin`
 * (the "tried the product / is active" signal) and `deploy` — so we can measure
 * adoption (distinct users/tenants who tried vs. deployed, plus MAU/DAU/WAU).
 *
 * Privacy: we never send raw PII. The user's email and its domain are reduced to
 * salted SHA-256 hashes before they leave the machine. The email hash is the
 * Application Insights `user_Id` (so `dcount(user_Id)` = distinct users) and the
 * domain hash rides along as a `tenantHash` custom dimension (distinct tenants).
 *
 * Transport: a dependency-free HTTPS POST of the Application Insights envelope to
 * the connection string's IngestionEndpoint `/v2/track`. No SDK is pulled into the
 * main bundle. Every send is fire-and-forget and swallows its own errors — telemetry
 * must never slow down or break a user action.
 *
 * Configuration: read from `resources/telemetry.json` (bundled, gitignored, written
 * by deploy.ps1 / CI). When the file is absent or has no connection string — e.g. a
 * local dev build — telemetry is a silent no-op.
 */

import { createHash, randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { release } from 'os'
import { request } from 'https'
import { app } from 'electron'

/**
 * Salt mixed into every hash. It only lives in the client (it ships in the
 * binary, so it is not a secret) — its job is to make the hashes app-specific and
 * stable across runs, so a given email always maps to the same `user_Id` and
 * `dcount` works. It must NEVER change once data is being collected, or historical
 * users would split into new identities.
 */
const HASH_SALT = 'rayfin-fabricator:telemetry:v1'

/** Logical service name reported to App Insights (ai.cloud.role). */
const CLOUD_ROLE = 'rayfin-fabricator'

interface TelemetryConfig {
  connectionString?: string
}

interface ParsedConnection {
  instrumentationKey: string
  /** Ingestion endpoint origin, e.g. https://eastus2-3.in.applicationinsights.azure.com */
  ingestionEndpoint: string
}

/** A pseudonymous identity resolved from the signed-in Fabric/Rayfin user. */
export interface TelemetryIdentity {
  /** Raw email/UPN — hashed here, never sent. */
  email?: string
  /** Raw tenant id/name — currently unused for hashing (we hash the email domain). */
  tenant?: string
}

let configLoaded = false
let parsedConnection: ParsedConnection | null = null
/** Stable per-process id; secondary to user_Id for activity analysis. */
const sessionId = randomUUID()

/** Read + parse `resources/telemetry.json` once. Missing/empty → telemetry off. */
function loadConfig(): ParsedConnection | null {
  if (configLoaded) return parsedConnection
  configLoaded = true
  try {
    const path = join(app.getAppPath(), 'resources', 'telemetry.json')
    const cfg = JSON.parse(readFileSync(path, 'utf8')) as TelemetryConfig
    parsedConnection = parseConnectionString(cfg.connectionString)
  } catch {
    parsedConnection = null
  }
  return parsedConnection
}

/**
 * Parse an Application Insights connection string
 * (`InstrumentationKey=…;IngestionEndpoint=https://…/;…`). Returns null when the
 * string is absent or doesn't carry both an key and an ingestion endpoint.
 */
function parseConnectionString(connectionString?: string): ParsedConnection | null {
  if (!connectionString || !connectionString.trim()) return null
  const parts: Record<string, string> = {}
  for (const segment of connectionString.split(';')) {
    const idx = segment.indexOf('=')
    if (idx === -1) continue
    const key = segment.slice(0, idx).trim().toLowerCase()
    const value = segment.slice(idx + 1).trim()
    if (key) parts[key] = value
  }
  const instrumentationKey = parts['instrumentationkey']
  if (!instrumentationKey) return null
  // Endpoint may omit a trailing slash; normalize to a bare origin.
  const endpoint = (parts['ingestionendpoint'] || 'https://dc.services.visualstudio.com').replace(
    /\/+$/,
    ''
  )
  return { instrumentationKey, ingestionEndpoint: endpoint }
}

/** Salted SHA-256 (hex) of a normalized value, or undefined for empty input. */
function hash(value: string | undefined | null): string | undefined {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return undefined
  return createHash('sha256').update(`${HASH_SALT}:${normalized}`).digest('hex')
}

/** Extract the domain portion of an email/UPN (the part after the last @). */
function emailDomain(email: string | undefined): string | undefined {
  if (!email) return undefined
  const at = email.lastIndexOf('@')
  return at >= 0 ? email.slice(at + 1) : undefined
}

/** POST one Application Insights envelope. Fire-and-forget; never throws. */
function send(conn: ParsedConnection, name: string, userId: string, properties: Record<string, string>): void {
  const envelope = {
    name: 'Microsoft.ApplicationInsights.Event',
    time: new Date().toISOString(),
    iKey: conn.instrumentationKey,
    tags: {
      'ai.user.id': userId,
      'ai.session.id': sessionId,
      'ai.cloud.role': CLOUD_ROLE,
      'ai.device.osVersion': `${process.platform} ${release()}`,
      'ai.internal.sdkVersion': `rayfin-fabricator:${appVersion()}`
    },
    data: {
      baseType: 'EventData',
      baseData: { ver: 2, name, properties }
    }
  }

  try {
    const body = Buffer.from(JSON.stringify(envelope), 'utf8')
    const url = new URL(`${conn.ingestionEndpoint}/v2/track`)
    const req = request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length
        },
        timeout: 5000
      },
      (res) => {
        // Drain so the socket can be freed; we don't care about the response body.
        res.on('data', () => {})
        res.on('end', () => {})
      }
    )
    req.on('error', () => {})
    req.on('timeout', () => req.destroy())
    req.write(body)
    req.end()
  } catch {
    /* never let telemetry surface an error to the caller */
  }
}

function appVersion(): string {
  try {
    return app.getVersion()
  } catch {
    return '0.0.0'
  }
}

/**
 * Track a custom event for a signed-in user. No-op when telemetry is unconfigured
 * or no email is available to derive a stable user id.
 */
function track(name: string, identity: TelemetryIdentity | null, props: Record<string, string>): void {
  const conn = loadConfig()
  if (!conn) return
  const userId = hash(identity?.email)
  if (!userId) return
  const tenantHash = hash(emailDomain(identity?.email))
  const properties: Record<string, string> = {
    ...props,
    appVersion: appVersion(),
    os: process.platform
  }
  if (tenantHash) properties.tenantHash = tenantHash
  send(conn, name, userId, properties)
}

/** Record a sign-in (or active-at-startup) event. */
export function trackSignin(identity: TelemetryIdentity | null, trigger: 'login' | 'startup'): void {
  track('signin', identity, { trigger })
}

/** Record a deploy attempt and whether it succeeded. */
export function trackDeploy(identity: TelemetryIdentity | null, success: boolean): void {
  track('deploy', identity, { success: String(success) })
}
