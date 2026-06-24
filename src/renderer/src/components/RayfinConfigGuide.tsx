import { useMemo, type ReactNode } from 'react'
import { parse } from 'yaml'
import { DatabaseIcon, FabricIcon, GlobeIcon, InfoIcon, KeyIcon, ShieldIcon } from './icons'

/**
 * A friendly, plain-language explainer for `rayfin/rayfin.yml` — the single most
 * important file in a Rayfin project. It parses the YAML and surfaces, at a glance,
 * what each backend service does so a non-coder can understand (and trust) their
 * app without reading config. Falls back gracefully if the file can't be parsed.
 */

interface AuthService {
  enabled?: boolean
  fabric?: { enabled?: boolean }
  password?: { enabled?: boolean }
  allowedRedirectUris?: string[]
  scopes?: string[]
  customClaims?: Record<string, unknown>
}
interface DataService {
  enabled?: boolean
  dialect?: string
}
interface HostingService {
  enabled?: boolean
  folder?: string
  buildCommand?: string
  indexDocument?: string
}
interface RayfinConfig {
  id?: string
  name?: string
  version?: string
  services?: {
    auth?: AuthService
    data?: DataService
    staticHosting?: HostingService
  }
}

/** Friendly names for the database dialects Rayfin supports. */
const DIALECTS: Record<string, { short: string; long: string }> = {
  mssql: { short: 'SQL Server', long: 'Microsoft SQL Server — a powerful relational database' },
  postgres: { short: 'PostgreSQL', long: 'PostgreSQL — a popular open-source database' },
  postgresql: { short: 'PostgreSQL', long: 'PostgreSQL — a popular open-source database' },
  sqlite: { short: 'SQLite', long: 'SQLite — a lightweight, file-based database' }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function Pill({ on }: { on: boolean }): JSX.Element {
  return (
    <span className={`cfg-pill${on ? ' cfg-pill--on' : ' cfg-pill--off'}`}>{on ? 'On' : 'Off'}</span>
  )
}

/** One service summarised in the at-a-glance status strip. */
function Tile({
  icon,
  name,
  on,
  sub
}: {
  icon: JSX.Element
  name: string
  on: boolean
  sub: string
}): JSX.Element {
  return (
    <div className={`cfg-tile${on ? '' : ' cfg-tile--off'}`}>
      <span className="cfg-tile-ico">{icon}</span>
      <span className="cfg-tile-text">
        <span className="cfg-tile-name">{name}</span>
        <span className="cfg-tile-sub" title={sub}>
          {sub}
        </span>
      </span>
      <span className={`cfg-dot${on ? ' cfg-dot--on' : ''}`} aria-hidden="true" />
    </div>
  )
}

function Section({
  icon,
  title,
  on,
  children
}: {
  icon: JSX.Element
  title: string
  on: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <section className="cfg-sec">
      <header className="cfg-sec-head">
        <span className="cfg-sec-ico">{icon}</span>
        <h3 className="cfg-sec-title">{title}</h3>
        <Pill on={on} />
      </header>
      <div className="cfg-sec-body">{children}</div>
    </section>
  )
}

/** A sign-in method, shown as a tight on/off row. */
function MethodRow({
  icon,
  label,
  desc,
  on
}: {
  icon: JSX.Element
  label: string
  desc: string
  on: boolean
}): JSX.Element {
  return (
    <div className={`cfg-meth${on ? '' : ' cfg-meth--off'}`}>
      <span className="cfg-meth-ico">{icon}</span>
      <span className="cfg-meth-text">
        <span className="cfg-meth-label">{label}</span>
        <span className="cfg-meth-desc">{desc}</span>
      </span>
      <Pill on={on} />
    </div>
  )
}

/** A compact label → value detail row. */
function Row({ k, hint, children }: { k: string; hint?: string; children: ReactNode }): JSX.Element {
  return (
    <div className="cfg-row">
      <span className="cfg-row-k">
        {k}
        {hint && <span className="cfg-row-hint">{hint}</span>}
      </span>
      <span className="cfg-row-v">{children}</span>
    </div>
  )
}

function Chips({ items }: { items: string[] }): JSX.Element {
  return (
    <span className="cfg-chips">
      {items.map((it, i) => (
        <code key={i}>{String(it)}</code>
      ))}
    </span>
  )
}

function Note({ children, warn }: { children: ReactNode; warn?: boolean }): JSX.Element {
  return <p className={`cfg-note${warn ? ' cfg-note--warn' : ''}`}>{children}</p>
}

export default function RayfinConfigGuide({ content }: { content: string }): JSX.Element {
  const cfg = useMemo<RayfinConfig | null>(() => {
    try {
      const parsed: unknown = parse(content)
      return isRecord(parsed) ? (parsed as RayfinConfig) : null
    } catch {
      return null
    }
  }, [content])

  if (!cfg) {
    return (
      <div className="cfg-guide cfg-guide--empty">
        <InfoIcon className="cfg-empty-icon" />
        <p>
          We couldn&apos;t turn this file into a friendly guide. Switch to <strong>YAML</strong> to
          view it directly.
        </p>
      </div>
    )
  }

  const auth = cfg.services?.auth
  const data = cfg.services?.data
  const hosting = cfg.services?.staticHosting
  const hasServices = !!cfg.services

  const authOn = !!auth?.enabled
  const dataOn = !!data?.enabled
  const hostingOn = !!hosting?.enabled
  const fabricOn = !!auth?.fabric?.enabled
  const passwordOn = !!auth?.password?.enabled
  const claims = auth && isRecord(auth.customClaims) ? Object.entries(auth.customClaims) : []
  const dialect = data?.dialect ? DIALECTS[data.dialect.toLowerCase()] : undefined

  // One-glance sub-labels for the status strip.
  const methods = [fabricOn && 'Microsoft', passwordOn && 'Password'].filter(Boolean) as string[]
  const authSub = !authOn ? 'Off' : methods.length ? methods.join(' · ') : 'No methods on'
  const dataSub = !dataOn ? 'Off' : (dialect?.short ?? data?.dialect ?? 'On')
  const hostingSub = !hostingOn ? 'Off' : hosting?.folder ? `/${hosting.folder}` : 'On'

  return (
    <div className="cfg-guide">
      <header className="cfg-id">
        <div className="cfg-id-main">
          <h2 className="cfg-id-name">{cfg.name || 'Your Rayfin app'}</h2>
          <p className="cfg-id-tag">
            Your app&apos;s backend blueprint — sign-in, data, and hosting at a glance.
          </p>
        </div>
        <div className="cfg-id-meta">
          {cfg.id && (
            <span className="cfg-chip">
              <span className="cfg-chip-k">ID</span>
              {cfg.id}
            </span>
          )}
          {cfg.version && (
            <span className="cfg-chip">
              <span className="cfg-chip-k">Ver</span>
              {cfg.version}
            </span>
          )}
          <span className="cfg-chip cfg-chip--file">rayfin/rayfin.yml</span>
        </div>
      </header>

      {hasServices ? (
        <>
          <div className="cfg-strip">
            <Tile icon={<ShieldIcon />} name="Sign-in" on={authOn} sub={authSub} />
            <Tile icon={<DatabaseIcon />} name="Database" on={dataOn} sub={dataSub} />
            <Tile icon={<GlobeIcon />} name="Hosting" on={hostingOn} sub={hostingSub} />
          </div>

          {auth && (
            <Section icon={<ShieldIcon />} title="Sign-in &amp; accounts" on={authOn}>
              {authOn ? (
                <>
                  <div className="cfg-meths">
                    <MethodRow
                      icon={<FabricIcon />}
                      label="Microsoft account"
                      desc="Work or school sign-in via Fabric / Entra ID"
                      on={fabricOn}
                    />
                    <MethodRow
                      icon={<KeyIcon />}
                      label="Email &amp; password"
                      desc="A classic email and password login"
                      on={passwordOn}
                    />
                  </div>
                  {!fabricOn && !passwordOn && (
                    <Note warn>No sign-in methods are on yet, so no one can sign in.</Note>
                  )}
                  {auth.allowedRedirectUris && auth.allowedRedirectUris.length > 0 && (
                    <Row k="Return URLs" hint="Where people land after signing in">
                      <Chips items={auth.allowedRedirectUris} />
                    </Row>
                  )}
                  {auth.scopes && auth.scopes.length > 0 && (
                    <Row k="Permissions" hint="What a signed-in user may do">
                      <Chips items={auth.scopes} />
                    </Row>
                  )}
                  {claims.length > 0 && (
                    <Row k="Custom claims" hint="Saved into each sign-in token">
                      <span className="cfg-chips">
                        {claims.map(([k, v]) => (
                          <code key={k}>
                            {k}={String(v)}
                          </code>
                        ))}
                      </span>
                    </Row>
                  )}
                </>
              ) : (
                <Note>Sign-in is off — anyone can use your app without an account.</Note>
              )}
            </Section>
          )}

          {data && (
            <Section icon={<DatabaseIcon />} title="Database" on={dataOn}>
              {dataOn ? (
                data.dialect ? (
                  <Row k="Type">{dialect?.long ?? data.dialect}</Row>
                ) : (
                  <Note>A managed database where your app stores and reads its data.</Note>
                )
              ) : (
                <Note>No managed database — your app won&apos;t store data on the backend.</Note>
              )}
            </Section>
          )}

          {hosting && (
            <Section icon={<GlobeIcon />} title="Website hosting" on={hostingOn}>
              {hostingOn ? (
                hosting.buildCommand || hosting.folder || hosting.indexDocument ? (
                  <>
                    {hosting.buildCommand && (
                      <Row k="Build step" hint="Builds your site before publishing">
                        <code>{hosting.buildCommand}</code>
                      </Row>
                    )}
                    {hosting.folder && (
                      <Row k="Published folder" hint="The folder served online">
                        <code>{hosting.folder}</code>
                      </Row>
                    )}
                    {hosting.indexDocument && (
                      <Row k="Home page">
                        <code>{hosting.indexDocument}</code>
                      </Row>
                    )}
                  </>
                ) : (
                  <Note>Publishes your built website so it&apos;s available online.</Note>
                )
              ) : (
                <Note>No website is being hosted from this project.</Note>
              )}
            </Section>
          )}
        </>
      ) : (
        <Note>This config doesn&apos;t define any services yet.</Note>
      )}

      <p className="cfg-foot">
        <InfoIcon className="cfg-foot-icon" />
        <span>
          A friendly summary of what matters most — switch to <strong>YAML</strong> for the exact
          file.
        </span>
      </p>
    </div>
  )
}
