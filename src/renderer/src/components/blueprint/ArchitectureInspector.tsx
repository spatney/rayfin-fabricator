import { useEffect, useState, type CSSProperties, type ReactNode, type JSX } from 'react'
import type { SecretInfo, SecretsState, StudioProject } from '@shared/ipc'
import {
  audienceKind,
  connectorKind,
  hardcodedSummary,
  ids,
  parsePort,
  type AppArchitecture,
  type AppIdentityInfo,
  type Identity,
  type Issue,
  type ServiceNode,
  type SourceNode
} from '../../model/architecture'
import { Codicon } from '../icons'
import { CopyButton } from '../chat/CopyButton'
import { relativeTime } from '../advisor/format'
import { SecretStatus } from '../secrets/SecretPanels'
import {
  appIdentityName,
  host,
  hueOf,
  IDENTITY_ICON,
  IDENTITY_LABEL,
  PORT_LABEL,
  portalOrigin,
  type DeployState
} from './util'
import {
  fixConnectorAuth,
  fixFunctionsAuth,
  grantAppAccess,
  hardenTables,
  moveKeysToSecrets,
  readTypedSecrets,
  reachAsTheApp,
  runAsEachPerson,
  runAsTheApp,
  type ChatPrompt
} from './prompts'
import type { FabricInfo } from './fabricInfo'
import '../skills/skills.css'

const DOCS = {
  identities: 'https://rayfin.ai/docs/auth/delegated-access',
  connectorAuth: 'https://rayfin.ai/docs/connectors/auth',
  connections: 'https://rayfin.ai/docs/functions/connections',
  secrets: 'https://rayfin.ai/docs/functions/secrets',
  permissions: 'https://rayfin.ai/docs/data/permissions',
  hosting: 'https://rayfin.ai/docs/hosting',
  storage: 'https://rayfin.ai/docs/storage',
  signIn: 'https://rayfin.ai/docs/auth'
}

interface Props {
  arch: AppArchitecture
  nodeId: string
  project: StudioProject
  deploy: DeployState
  appIdentity: AppIdentityInfo
  workspaceName?: string
  info: FabricInfo | null
  onClose: () => void
  onSelect: (nodeId: string) => void
  onOpenFile: (path: string) => void
  onPrompt: (prompt: ChatPrompt) => void
  onOpenEntity: (entity: string) => void
  onOpenSemanticModel: (key: string) => void
  /** Open Code → Secrets, where values are added and changed. */
  onOpenSecrets?: () => void
}

const open = (url: string): void => void window.api.openExternal(url)

/** Details for whatever is selected in the Architecture view. */
export default function ArchitectureInspector(props: Props): JSX.Element | null {
  const { arch, nodeId } = props
  if (nodeId === ids.people) return <PeopleDetails {...props} />
  if (nodeId === ids.app) return <AppDetails {...props} />
  const port = parsePort(nodeId)
  if (port) {
    const svc = arch.services.find((s) => s.id === port.service)
    return <IdentityDetails {...props} identity={port.identity} via={svc} />
  }
  if (nodeId.startsWith('id:')) return <IdentityDetails {...props} identity={nodeId.slice(3) as Identity} />
  const svc = arch.services.find((s) => s.id === nodeId)
  if (svc) return <ServiceDetails {...props} svc={svc} />
  const src = arch.sources.find((s) => s.id === nodeId)
  if (src) return <SourceDetails {...props} src={src} />
  return null
}

/* ------------------------------- frame ------------------------------- */

function Panel({
  kicker,
  title,
  glyph,
  onClose,
  children,
  actions
}: {
  kicker: string
  title: string
  glyph: ReactNode
  onClose: () => void
  children: ReactNode
  actions?: ReactNode
}): JSX.Element {
  return (
    <aside className="bp-insp" aria-label={`${title} details`}>
      <header className="bp-insp-head">
        {glyph}
        <div className="bp-insp-titles">
          <span className="bp-insp-kicker">{kicker}</span>
          <h3 className="bp-insp-title">{title}</h3>
        </div>
        <button type="button" className="bp-insp-close" onClick={onClose} aria-label="Close details" title="Close (Esc)">
          <Codicon name="close" />
        </button>
      </header>
      <div className="bp-insp-body">{children}</div>
      {actions && <footer className="bp-insp-actions">{actions}</footer>}
    </aside>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="bp-insp-section">
      <h4 className="bp-insp-h">{title}</h4>
      {children}
    </section>
  )
}

function Facts({ rows }: { rows: [string, ReactNode | undefined | false][] }): JSX.Element {
  return (
    <dl className="bp-facts-list">
      {rows
        .filter(([, v]) => v !== undefined && v !== false && v !== '')
        .map(([k, v]) => (
          <div key={k} className="bp-fact-row">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
    </dl>
  )
}

function Issues({ issues }: { issues: Issue[] }): JSX.Element | null {
  if (!issues.length) return null
  return (
    <div className="bp-issues">
      {issues.map((issue, i) => (
        <div key={i} className={`bp-issue bp-issue--${issue.tone}`} role={issue.tone === 'danger' ? 'alert' : undefined}>
          <Codicon name={issue.tone === 'info' ? 'info' : 'warning'} />
          <span>
            <Code text={issue.text} />
          </span>
        </div>
      ))}
    </div>
  )
}

/** Render `backtick` spans in short sentences as code. */
function Code({ text }: { text: string }): JSX.Element {
  const parts = text.split('`')
  return <>{parts.map((p, i) => (i % 2 ? <code key={i}>{p}</code> : <span key={i}>{p}</span>))}</>
}

function Guid({ value }: { value: string }): JSX.Element {
  return (
    <span className="bp-guid">
      <code title={value}>{value}</code>
      <CopyButton text={value} compact title="Copy" className="bp-guid-copy" />
    </span>
  )
}

function DocLink({ href, children }: { href: string; children: ReactNode }): JSX.Element {
  return (
    <button type="button" className="bp-doclink" onClick={() => open(href)}>
      <Codicon name="book" /> {children}
    </button>
  )
}

function Glyph({ icon, tone }: { icon: string; tone: string }): JSX.Element {
  return (
    <span className={`bp-insp-glyph bp-insp-glyph--${tone}`} aria-hidden="true">
      <Codicon name={icon} />
    </span>
  )
}

/** "Signs in as" for one connection: the identity, and whose credentials it is. */
function SignsInAs({
  identity,
  appIdentity,
  target,
  onSelect
}: {
  identity: Identity
  appIdentity: AppIdentityInfo
  /** The node that explains it: the app identity, or the port the source is reached through. */
  target: string
  onSelect: (id: string) => void
}): JSX.Element {
  return (
    <button type="button" className={`bp-signs bp-signs--${identity}`} onClick={() => onSelect(target)}>
      <span className={`bp-glyph bp-glyph--${identity}`} aria-hidden="true">
        <Codicon name={IDENTITY_ICON[identity]} />
      </span>
      <span className="bp-signs-text">
        <strong>{IDENTITY_LABEL[identity]}</strong>
        <span>
          {identity === 'user'
            ? 'Delegated: runs as whoever is signed in, with their own Fabric access.'
            : identity === 'app'
              ? `Application: runs as ${whoText(appIdentity)}, the same for everyone.`
              : 'A key or token the function sends itself, not a Fabric sign-in.'}
        </span>
      </span>
      <Codicon name="chevron-right" className="bp-signs-go" />
    </button>
  )
}

function whoText(identity: AppIdentityInfo): string {
  if (identity.kind === 'service-principal') return `the service principal ${identity.who}`
  if (identity.kind === 'account' && identity.who) return identity.who
  return 'the owner of the Fabric app'
}

function SourceList({ arch, sources, onSelect, grant }: {
  arch: AppArchitecture
  sources: SourceNode[]
  onSelect: (id: string) => void
  grant?: boolean
}): JSX.Element {
  return (
    <ul className="bp-list">
      {sources.map((s) => (
        <li key={s.id}>
          <button type="button" className="bp-list-row" onClick={() => onSelect(s.id)}>
            <span className={`bp-tile bp-tile--sm bp-tile--${s.vendor}`} aria-hidden="true">
              <Codicon name={s.icon} />
            </span>
            <span className="bp-list-text">
              <strong>{s.title}</strong>
              <span>{grant && s.audience ? audienceKind(s.audience).grant : grant ? grantFor(s) : s.typeLabel}</span>
            </span>
            <Codicon name="chevron-right" className="bp-list-go" />
          </button>
        </li>
      ))}
      {sources.length === 0 && <li className="bp-list-empty">{arch.sources.length ? 'None' : 'Nothing yet'}</li>}
    </ul>
  )
}

function grantFor(s: SourceNode): string {
  if (s.audience) return audienceKind(s.audience).grant
  return 'A role on its Fabric workspace, or permission on the item.'
}

/** One row that opens the Secrets part. */
function SecretsLink({ arch, onSelect }: { arch: AppArchitecture; onSelect: (id: string) => void }): JSX.Element {
  const n = arch.keys.secrets.length
  return (
    <ul className="bp-list">
      <li>
        <button type="button" className="bp-list-row" onClick={() => onSelect(ids.service('secrets'))}>
          <span className="bp-tile bp-tile--sm" aria-hidden="true">
            <Codicon name="lock" />
          </span>
          <span className="bp-list-text">
            <strong>{n === 1 ? '1 secret' : `${n} secrets`}</strong>
            <span className="bp-mono">{arch.keys.secrets.map((s) => s.name).join(', ')}</span>
          </span>
          <Codicon name="chevron-right" className="bp-list-go" />
        </button>
      </li>
    </ul>
  )
}

/* ------------------------------- kinds ------------------------------- */

function PeopleDetails({ arch, deploy, onClose, onOpenFile }: Props): JSX.Element {
  const p = arch.people
  return (
    <Panel
      kicker="Who uses it"
      title="People"
      glyph={<Glyph icon="organization" tone="people" />}
      onClose={onClose}
      actions={
        <>
          {deploy.url && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => open(deploy.url!)}>
              <Codicon name="globe" /> Open the app
            </button>
          )}
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => onOpenFile('rayfin/rayfin.yml')}>
            Open rayfin.yml
          </button>
        </>
      }
    >
      <p className="bp-insp-lead">
        People open the app at its address or inside Fabric and sign in with their work account. To let
        someone in, select <strong>Share</strong> in the app bar.
      </p>
      <Issues issues={p.issues} />
      <Facts
        rows={[
          ['Sign-in', p.signIn],
          [
            'Pages',
            arch.config.hosting.enabled &&
              (p.access === 'public'
                ? 'Load before sign-in'
                : p.access === 'protected'
                  ? 'Load after sign-in'
                  : 'Not set yet')
          ],
          ['Opens', p.embeddedOnly ? 'Only inside the Fabric portal' : 'At its own address and inside Fabric'],
          ['Address', deploy.url && host(deploy.url)]
        ]}
      />
      <DocLink href={DOCS.signIn}>How people sign in</DocLink>
    </Panel>
  )
}

function AppDetails({ arch, project, deploy, workspaceName, onClose, onOpenFile, onSelect }: Props): JSX.Element {
  return (
    <Panel
      kicker="Fabric app"
      title={arch.name}
      glyph={
        <span className="bp-insp-glyph bp-mark" style={{ '--hue': hueOf(arch.name) } as CSSProperties} aria-hidden="true">
          {arch.name.trim()[0]?.toUpperCase() ?? '?'}
        </span>
      }
      onClose={onClose}
      actions={
        <>
          {deploy.url && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => open(deploy.url!)}>
              <Codicon name="globe" /> Open the app
            </button>
          )}
          {deploy.portalUrl && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => open(deploy.portalUrl!)}>
              <Codicon name="link-external" /> Open in Fabric
            </button>
          )}
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => onOpenFile('rayfin/rayfin.yml')}>
            Open rayfin.yml
          </button>
        </>
      }
    >
      <p className="bp-insp-lead">
        Rayfin runs the app as one Fabric app item: its pages, sign-in, database and functions, set up from{' '}
        <code>rayfin/rayfin.yml</code>.
      </p>
      <Facts
        rows={[
          ['Workspace', workspaceName],
          ['Address', deploy.url ? host(deploy.url) : 'Not deployed yet'],
          ['Last deploy', project.lastDeploy?.at && relativeTime(project.lastDeploy.at)],
          ['Project', project.path]
        ]}
      />
      <Section title="Parts">
        <ul className="bp-list">
          {arch.services.map((s) => (
            <li key={s.id}>
              <button type="button" className="bp-list-row" onClick={() => onSelect(s.id)}>
                <span className="bp-tile bp-tile--sm" aria-hidden="true">
                  <Codicon name={s.icon} />
                </span>
                <span className="bp-list-text">
                  <strong>{s.title}</strong>
                  <span>{s.summary}</span>
                </span>
                <Codicon name="chevron-right" className="bp-list-go" />
              </button>
            </li>
          ))}
        </ul>
      </Section>
    </Panel>
  )
}

function IdentityDetails({
  arch,
  identity,
  via,
  appIdentity,
  deploy,
  onClose,
  onSelect,
  onPrompt
}: Props & { identity: Identity; via?: ServiceNode }): JSX.Element {
  // From a part's port: only what that part reaches this way.
  const sources = arch.sources.filter((s) =>
    via
      ? arch.routes.some((r) => r.service === via.id && r.identity === identity && r.source === s.id)
      : s.identity === identity
  )
  const kicker = via ? via.title : 'Identity'
  const title = via ? PORT_LABEL[identity] : IDENTITY_LABEL[identity]
  if (identity === 'key') {
    const keys = arch.keys
    return (
      <Panel
        kicker={kicker}
        title={title}
        glyph={<Glyph icon={IDENTITY_ICON.key} tone="key" />}
        onClose={onClose}
        actions={
          keys.hardcoded.length > 0 && (
            <button type="button" className="btn btn--sm btn--primary" onClick={() => onPrompt(moveKeysToSecrets(keys.hardcoded))}>
              <Codicon name="sparkle" /> Move keys into secrets
            </button>
          )
        }
      >
        <p className="bp-insp-lead">
          These calls don’t use a Fabric sign-in. The function sends its own key or token (or none, for a public
          API), so anyone who holds that key has the same access, whoever is using the app.
        </p>
        <Issues
          issues={keys.hardcoded.length ? [{ tone: 'danger', text: hardcodedSummary(keys.hardcoded) }] : []}
        />
        <Section title="Reached with a key">
          <SourceList arch={arch} sources={sources} onSelect={onSelect} />
        </Section>
        <Section title="Secrets the functions use">
          {keys.secrets.length ? (
            <SecretsLink arch={arch} onSelect={onSelect} />
          ) : (
            <p className="bp-insp-note">
              None. Store keys with <code>rayfin secret set</code> and read them from <code>ctx.Secrets</code>, so
              they never sit in the code.
            </p>
          )}
        </Section>
        <DocLink href={DOCS.secrets}>Secrets in functions</DocLink>
      </Panel>
    )
  }
  if (identity === 'user') {
    return (
      <Panel kicker={kicker} title={title} glyph={<Glyph icon={IDENTITY_ICON.user} tone="user" />} onClose={onClose}>
        <p className="bp-insp-lead">
          These connections are <strong>delegated</strong>: every query runs as the person using the app, through
          an on-behalf-of token exchange. Fabric checks their own permissions, so each person only sees what
          they’re allowed to.
        </p>
        <Section title="Everyone who uses the app needs access to">
          <SourceList arch={arch} sources={sources} onSelect={onSelect} />
        </Section>
        <p className="bp-insp-note">
          Give people, or a group they’re in, a role on each workspace or permission on each item. Without it they
          get an authorization error.
        </p>
        <DocLink href={DOCS.identities}>Delegated and application access</DocLink>
      </Panel>
    )
  }
  return (
    <Panel
      kicker={via ? kicker : arch.name}
      title={via ? title : 'App identity'}
      glyph={<Glyph icon={IDENTITY_ICON.app} tone="app" />}
      onClose={onClose}
      actions={
        sources.length > 0 && (
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => onPrompt(grantAppAccess(whoText(appIdentity), sources.map((s) => s.title)))}
          >
            <Codicon name="sparkle" /> Ask Copilot what to grant
          </button>
        )
      }
    >
      <p className="bp-insp-lead">
        {via ? 'These connections use' : 'Connections that use the app identity have'} <strong>application</strong>{' '}
        access: one shared identity, the owner of the Fabric app item. Everyone sees the same data there, and
        per-person rules can’t tell people apart.
      </p>
      <Section title="Whose credentials">
        <div className="bp-who">
          <span className={`bp-who-avatar${appIdentity.kind === 'service-principal' ? ' bp-who-avatar--sp' : ''}`}>
            <Codicon name={appIdentity.kind === 'service-principal' ? 'server-process' : 'account'} />
          </span>
          <div className="bp-who-text">
            <strong>{appIdentityName(appIdentity, Boolean(deploy.url))}</strong>
            <span>
              {appIdentity.kind === 'service-principal'
                ? 'Service principal that deploys the published app'
                : appIdentity.kind === 'account'
                  ? 'Your Fabric account, which deploys this app'
                  : 'Owner of the Fabric app item'}
            </span>
          </div>
        </div>
        {appIdentity.clientId && <Facts rows={[['Client ID', <Guid value={appIdentity.clientId} />]]} />}
        {appIdentity.preview && (
          <p className="bp-insp-note">
            Previews run as <strong>{appIdentity.preview.who}</strong>, which deploys them from pull requests.
          </p>
        )}
        {appIdentity.kind === 'account' && (
          <p className="bp-insp-note">
            The owner is the account that created the app with its first deploy. If someone else deployed it
            first, it runs as them.
          </p>
        )}
      </Section>
      <Section title="Grant it access to">
        <SourceList arch={arch} sources={sources} onSelect={onSelect} grant />
      </Section>
      {arch.functions && sources.some((s) => s.audience) && (
        <p className="bp-insp-note">
          While you test locally with <code>rayfin dev</code>, functions use your own sign-in instead, so a call
          that works on your computer can still fail once deployed.
        </p>
      )}
      <DocLink href={DOCS.identities}>Delegated and application access</DocLink>
    </Panel>
  )
}

function ServiceDetails(props: Props & { svc: ServiceNode }): JSX.Element {
  const { arch, svc, deploy, onClose, onSelect, onOpenFile, onPrompt, onOpenEntity } = props
  const reached = arch.routes.filter((r) => r.service === svc.id).map((r) => r.source)
  const sources = arch.sources.filter((s) => reached.includes(s.id))
  const yml = (
    <button type="button" className="btn btn--sm btn--ghost" onClick={() => onOpenFile('rayfin/rayfin.yml')}>
      Open rayfin.yml
    </button>
  )
  const glyph = <Glyph icon={svc.icon} tone={svc.tone ?? 'neutral'} />
  const frame = (lead: ReactNode, body: ReactNode, actions: ReactNode = yml): JSX.Element => (
    <Panel kicker={arch.name} title={svc.title} glyph={glyph} onClose={onClose} actions={actions}>
      <p className="bp-insp-lead">{lead}</p>
      <Issues issues={svc.issues} />
      {body}
    </Panel>
  )

  switch (svc.kind) {
    case 'website':
      return frame(
        <>The app’s pages: the HTML, JavaScript and CSS built from its code, served from the Fabric app.</>,
        <>
          <Facts
            rows={[
              [
                'Pages load',
                arch.people.access === 'public'
                  ? 'Before sign-in'
                  : arch.people.access === 'protected'
                    ? 'After sign-in'
                    : 'Not set yet'
              ],
              ['Setting', <code>assetAccess: {arch.config.hosting.assetAccess ?? 'not set'}</code>],
              ['Opens', arch.config.hosting.embeddedOnly ? 'Only inside Fabric' : 'At its own address and inside Fabric'],
              ['Build output', arch.config.hosting.folder && <code>{arch.config.hosting.folder}</code>],
              ['Address', deploy.url && host(deploy.url)]
            ]}
          />
          {arch.people.access === 'public' && (
            <p className="bp-insp-note">
              Anyone with the link can download the page files, but not the app’s data: that still needs sign-in,
              and entity rules decide what each person sees. That’s usual for web apps. To load the pages only after
              a Fabric sign-in, set <code>assetAccess: protected</code>.
            </p>
          )}
          {arch.people.access === 'protected' && (
            <p className="bp-insp-note">The page files only load for people signed in to Fabric.</p>
          )}
          {sources.length > 0 && (
            <Section title="Reads in the browser">
              <SourceList arch={arch} sources={sources} onSelect={onSelect} />
            </Section>
          )}
          <DocLink href={DOCS.hosting}>Static hosting</DocLink>
        </>
      )
    case 'signin': {
      const uris = arch.config.auth.redirectUris
      return frame(
        <>People sign in with their Microsoft Entra ID work account. The app gets a session that says who they are.</>,
        <>
          <Facts
            rows={[
              ['Provider', arch.people.signIn],
              ['Entra tokens from other apps', arch.config.auth.enabled && (arch.config.auth.externalEntraExchange ? 'Accepted' : 'Not accepted')]
            ]}
          />
          {uris.length > 0 && (
            <Section title="Sign-in addresses">
              <ul className="bp-plain">
                {uris.slice(0, 6).map((u) => (
                  <li key={u}>
                    <code>{u}</code>
                  </li>
                ))}
                {uris.length > 6 && <li className="bp-insp-note">and {uris.length - 6} more</li>}
              </ul>
            </Section>
          )}
          <DocLink href={DOCS.signIn}>Sign-in</DocLink>
        </>
      )
    }
    case 'database': {
      const db = arch.database
      const loose = (db?.tables ?? []).filter((t) => t.tone !== 'ok')
      return frame(
        <>
          The app’s own tables, in its Fabric SQL database. Reads and writes use the <strong>user’s identity</strong>,
          and each table’s rules decide which rows they can see and change.
        </>,
        <>
          <Section title={`${db?.tables.length ?? 0} tables`}>
            <ul className="bp-list">
              {(db?.tables ?? []).map((t) => (
                <li key={t.entity}>
                  <button type="button" className="bp-list-row" onClick={() => onOpenEntity(t.entity)}>
                    <span className={`bp-dot bp-dot--${t.tone}`} aria-hidden="true" />
                    <span className="bp-list-text">
                      <strong>{t.name}</strong>
                      <span>{t.label}</span>
                    </span>
                    <span className="bp-list-hint">Data model</span>
                    <Codicon name="chevron-right" className="bp-list-go" />
                  </button>
                </li>
              ))}
              {!db?.tables.length && <li className="bp-list-empty">No tables yet</li>}
            </ul>
          </Section>
          <DocLink href={DOCS.permissions}>Permissions and row-level security</DocLink>
        </>,
        <>
          {loose.length > 0 && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => onPrompt(hardenTables(loose))}>
              <Codicon name="shield" /> Harden access
            </button>
          )}
          {db?.tables.length ? (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => onOpenEntity('')}>
              Open the data model
            </button>
          ) : null}
        </>
      )
    }
    case 'storage':
      return frame(
        <>Blob storage for files people upload. It’s experimental and not available in every Fabric region.</>,
        <DocLink href={DOCS.storage}>Storage</DocLink>
      )
    case 'functions': {
      const fns = arch.functions
      // Only a wrong `services.functions.auth.type` is this fix; keys in the code have their own.
      const authIssue =
        arch.config.functions.enabled && arch.config.functions.authType?.toLowerCase() !== 'application'
      return frame(
        <>
          Server-side code. Calls to outside services use the <strong>app identity</strong>; reading the app’s own
          data still uses the identity of the user who called the function.
        </>,
        <>
          <Section title={fns?.functions.length ? `${fns.functions.length} functions` : 'Functions'}>
            <ul className="bp-plain bp-fns">
              {(fns?.functions ?? []).map((f) => (
                <li key={`${f.file}:${f.name}`}>
                  <code>{f.name}</code>
                  {f.audiences.map((a) => (
                    <span key={a} className="bp-chip bp-chip--app">
                      {audienceKind(a).label}
                    </span>
                  ))}
                </li>
              ))}
              {!fns?.functions.length && <li className="bp-insp-note">No functions found yet.</li>}
            </ul>
          </Section>
          {sources.length > 0 && (
            <Section title="Reaches">
              <SourceList arch={arch} sources={sources} onSelect={onSelect} />
            </Section>
          )}
          {arch.keys.secrets.length > 0 && (
            <Section title="Secrets">
              <SecretsLink arch={arch} onSelect={onSelect} />
            </Section>
          )}
          <DocLink href={DOCS.connections}>Function connections</DocLink>
        </>,
        <>
          {authIssue && (
            <button type="button" className="btn btn--sm btn--primary" onClick={() => onPrompt(fixFunctionsAuth())}>
              <Codicon name="sparkle" /> Fix with Copilot
            </button>
          )}
          {!authIssue && arch.keys.hardcoded.length > 0 && (
            <button
              type="button"
              className="btn btn--sm btn--primary"
              onClick={() => onPrompt(moveKeysToSecrets(arch.keys.hardcoded))}
            >
              <Codicon name="sparkle" /> Move keys into secrets
            </button>
          )}
          {fns?.files[0] && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => onOpenFile(fns.files[0])}>
              Open the code
            </button>
          )}
          {yml}
        </>
      )
    }
    case 'secrets':
      return <SecretsDetails {...props} />
    case 'connectors':
      return frame(
        <>
          Existing Fabric data the app reads and writes through Rayfin connectors. Each one uses the user’s identity
          or the app identity, set by <code>auth.type</code> in <code>rayfin/rayfin.yml</code>.
        </>,
        <>
          <Section title="Connectors">
            <SourceList arch={arch} sources={sources} onSelect={onSelect} />
          </Section>
          <DocLink href={DOCS.connectorAuth}>Connector authentication</DocLink>
        </>
      )
  }
}

/** What the deployed app holds, for the Secrets panel: by name, or why it can't say. */
type StoredValues = { status: 'loading' } | { status: SecretsState['status'] | 'unavailable'; byName: Map<string, SecretInfo>; signIn?: boolean }

function useStoredSecrets(projectId: string): StoredValues {
  const [state, setState] = useState<StoredValues>({ status: 'loading' })
  useEffect(() => {
    let alive = true
    if (!window.api?.secrets?.list) {
      setState({ status: 'unavailable', byName: new Map() })
      return
    }
    setState({ status: 'loading' })
    window.api.secrets.list(projectId).then(
      (res) => {
        if (!alive) return
        if (res.status === 'team') {
          // A team app shows its published deployment's values.
          const published = res.environments?.find((e) => e.kind === 'published')
          setState(
            published?.deployed && !published.error
              ? { status: 'team', byName: new Map(published.secrets.map((s) => [s.name, s])) }
              : { status: published?.error ? 'error' : 'not-deployed', byName: new Map() }
          )
          return
        }
        setState({ status: res.status, byName: new Map(res.secrets.map((s) => [s.name, s])), signIn: res.signIn })
      },
      () => {
        if (alive) setState({ status: 'error', byName: new Map() })
      }
    )
    return () => {
      alive = false
    }
  }, [projectId])
  return state
}

function SecretsDetails({
  arch,
  svc,
  project,
  onClose,
  onSelect,
  onOpenFile,
  onPrompt,
  onOpenSecrets
}: Props & { svc: ServiceNode }): JSX.Element {
  const stored = useStoredSecrets(project.id)
  const known = stored.status === 'ready' || stored.status === 'team'
  const byName = stored.status === 'loading' ? new Map<string, SecretInfo>() : stored.byName
  // Values the deployed app holds that neither rayfin.yml nor the code mention.
  const extra = known
    ? [...byName.values()].filter((s) => !arch.keys.secrets.some((k) => k.name === s.name))
    : []
  const sentTo = arch.sources.filter((s) =>
    arch.routes.some((r) => r.service === svc.id && r.source === s.id)
  )
  const hardcoded = arch.keys.hardcoded
  const legacy = arch.keys.secrets.filter((s) => s.legacy).map((s) => s.name)
  const missing = known
    ? arch.keys.secrets.filter((s) => s.declared && s.files.length > 0 && !byName.get(s.name)?.stored)
    : []

  return (
    <Panel
      kicker={arch.name}
      title="Secrets"
      glyph={<Glyph icon={svc.icon} tone={svc.tone ?? 'neutral'} />}
      onClose={onClose}
      actions={
        <>
          {hardcoded.length > 0 && (
            <button type="button" className="btn btn--sm btn--primary" onClick={() => onPrompt(moveKeysToSecrets(hardcoded))}>
              <Codicon name="sparkle" /> Move keys into secrets
            </button>
          )}
          {onOpenSecrets && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={onOpenSecrets}>
              <Codicon name="lock" /> Manage secrets
            </button>
          )}
          {legacy.length > 0 && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => onPrompt(readTypedSecrets(legacy))}>
              <Codicon name="sparkle" /> Read as ctx.Secrets
            </button>
          )}
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => onOpenFile('rayfin/rayfin.yml')}>
            Open rayfin.yml
          </button>
        </>
      }
    >
      <p className="bp-insp-lead">
        API keys, passwords and connection strings for the functions. Values are stored on the deployed Fabric app,
        never in the code: <code>rayfin.yml</code> keeps only their names and descriptions, and functions read them
        as <code>ctx.Secrets.NAME</code>.
      </p>
      <Issues
        issues={[
          ...svc.issues,
          ...(hardcoded.length ? [{ tone: 'danger' as const, text: hardcodedSummary(hardcoded) }] : []),
          ...(missing.length
            ? [
                {
                  tone: 'warn' as const,
                  text: `The deployed app has no value for ${missing.map((s) => `\`${s.name}\``).join(', ')}, so a function that reads ${missing.length === 1 ? 'it' : 'them'} fails.`
                }
              ]
            : [])
        ]}
      />
      <Section title={arch.keys.secrets.length === 1 ? '1 secret' : `${arch.keys.secrets.length} secrets`}>
        <ul className="bp-list">
          {arch.keys.secrets.map((s) => {
            const info = byName.get(s.name)
            const readBy = s.functions.length
              ? `Read by ${s.functions.join(', ')}`
              : s.files.length
                ? `Read in ${s.files.map((f) => f.split('/').pop()).join(', ')}`
                : 'No function reads it'
            const body = (
              <>
                <span className="bp-tile bp-tile--sm" aria-hidden="true">
                  <Codicon name="key" />
                </span>
                <span className="bp-list-text">
                  <strong className="bp-mono">{s.name}</strong>
                  {s.description && <span>{s.description}</span>}
                  <span className="bp-list-sub">{s.declared ? readBy : `${readBy} · not in rayfin.yml`}</span>
                </span>
                {info && <SecretStatus secret={info} />}
              </>
            )
            return (
              <li key={s.name}>
                {s.files[0] ? (
                  <button
                    type="button"
                    className="bp-list-row"
                    title={`Open ${s.files[0]}`}
                    onClick={() => onOpenFile(s.files[0])}
                  >
                    {body}
                    <Codicon name="chevron-right" className="bp-list-go" />
                  </button>
                ) : (
                  <div className="bp-list-row bp-list-row--static">{body}</div>
                )}
              </li>
            )
          })}
          {extra.map((s) => (
            <li key={s.name}>
              <div className="bp-list-row bp-list-row--static">
                <span className="bp-tile bp-tile--sm" aria-hidden="true">
                  <Codicon name="key" />
                </span>
                <span className="bp-list-text">
                  <strong className="bp-mono">{s.name}</strong>
                  <span className="bp-list-sub">Stored on the app only</span>
                </span>
                <SecretStatus secret={s} />
              </div>
            </li>
          ))}
        </ul>
        <p className="bp-insp-note">
          {stored.status === 'loading'
            ? 'Checking which values the deployed app has…'
            : stored.status === 'not-deployed'
              ? 'Values are stored with the deployed app, so they can be added once it’s deployed.'
              : stored.status === 'team'
                ? 'Shows the published app’s values. Each deployment of a team app keeps its own.'
                : stored.status === 'update-rayfin'
                  ? 'Update the app’s Rayfin version to see which values are set.'
                  : stored.status === 'error'
                    ? stored.signIn
                      ? 'Couldn’t check the deployed app’s values. Your Fabric sign-in may have expired.'
                      : 'Couldn’t check the deployed app’s values.'
                    : stored.status === 'ready'
                      ? 'Values are write-only: Fabricator shows whether one is set, never what it is.'
                      : null}
        </p>
      </Section>
      {sentTo.length > 0 && (
        <Section title="Called from the same code">
          <SourceList arch={arch} sources={sentTo} onSelect={onSelect} />
        </Section>
      )}
      <p className="bp-insp-note">
        While you test with <code>rayfin dev</code>, functions read values from{' '}
        <code>rayfin/functions/local.settings.json</code> instead.
      </p>
      <DocLink href={DOCS.secrets}>Secrets in functions</DocLink>
    </Panel>
  )
}

function SourceDetails({
  arch,
  src,
  project,
  appIdentity,
  info,
  onClose,
  onSelect,
  onOpenFile,
  onPrompt,
  onOpenSemanticModel
}: Props & { src: SourceNode }): JSX.Element {
  const ws = src.workspaceId ? info?.workspaces.get(src.workspaceId.toLowerCase()) : undefined
  const model = src.itemId ? info?.models.get(src.itemId.toLowerCase()) : undefined
  const connector = src.connectors[0]
  const kind = connector ? connectorKind(connector.type) : undefined
  const audience = src.audience ? audienceKind(src.audience) : undefined
  const from = [...new Set(arch.routes.filter((r) => r.source === src.id).map((r) => r.service))]
    .map((id) => arch.services.find((s) => s.id === id)?.title)
    .filter(Boolean)
  const badAuth = connector && src.issues.some((i) => i.tone === 'danger')
  const workspaceUrl = src.workspaceId ? `${portalOrigin(project)}/groups/${encodeURIComponent(src.workspaceId)}` : undefined
  const via = arch.routes.find(
    (r) => r.source === src.id && r.identity === src.identity && r.service !== ids.service('secrets')
  )
  const signsTarget =
    src.identity === 'app' || !via ? ids.identity(src.identity) : ids.port(via.service, via.identity)

  const actions = (
    <>
      {badAuth && connector && (
        <button type="button" className="btn btn--sm btn--primary" onClick={() => onPrompt(fixConnectorAuth(connector))}>
          <Codicon name="sparkle" /> Fix with Copilot
        </button>
      )}
      {src.suggestedAudience && (
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={() => onPrompt(reachAsTheApp(src.title, src.suggestedAudience!, src.hosts, src.files))}
        >
          <Codicon name="sparkle" /> Use app identity
        </button>
      )}
      {src.semanticKey && (
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => onOpenSemanticModel(src.semanticKey!)}>
          <Codicon name="graph" /> View the model
        </button>
      )}
      {(model?.webUrl || workspaceUrl) && (
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => open(model?.webUrl ?? workspaceUrl!)}>
          <Codicon name="link-external" /> Open in Fabric
        </button>
      )}
      {!badAuth && connector && kind?.category === 'A' && (
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={() => onPrompt(src.identity === 'app' ? runAsEachPerson(connector) : runAsTheApp(connector))}
        >
          <Codicon name="sparkle" /> {src.identity === 'app' ? 'Use user’s identity' : 'Use app identity'}
        </button>
      )}
      {src.files.map((f) => (
        <button key={f} type="button" className="btn btn--sm btn--ghost" onClick={() => onOpenFile(f)}>
          Open {f.split('/').pop()}
        </button>
      ))}
    </>
  )

  return (
    <Panel
      kicker={src.typeLabel}
      title={src.title}
      glyph={
        <span className={`bp-insp-glyph bp-tile bp-tile--${src.vendor}`} aria-hidden="true">
          <Codicon name={src.icon} />
        </span>
      }
      onClose={onClose}
      actions={actions}
    >
      <Issues issues={src.issues} />
      {audience && (
        <p className="bp-insp-lead">
          {audience.detail}, reached from functions through <code>ctx.Tokens.{src.audience}</code>.
        </p>
      )}
      {src.kind === 'api' && (
        <p className="bp-insp-lead">
          A web API the functions call. Rayfin doesn’t sign these calls in: the code sends its own key or token.
        </p>
      )}
      {src.suggestedAudience && (
        <div className="bp-issue bp-issue--info">
          <Codicon name="lightbulb" />
          <span>
            Rayfin can reach {src.title} with the app identity through <code>AudienceType.{src.suggestedAudience}</code>, so the
            functions don’t need a key for it.
          </span>
        </div>
      )}
      <Section title="Identity">
        <SignsInAs identity={src.identity} appIdentity={appIdentity} target={signsTarget} onSelect={onSelect} />
        {connector && kind?.category === 'B' && (
          <p className="bp-insp-note">{kind.label} connectors always use the user’s identity.</p>
        )}
        {connector && kind?.category === 'A' && (
          <p className="bp-insp-note">
            {src.identity === 'app'
              ? 'Everyone sees the same rows, so per-person rules on its tables can’t tell people apart.'
              : 'Each person’s own Fabric access applies, and per-person rules on its tables can use who they are.'}
          </p>
        )}
      </Section>
      <Section title="Details">
        <Facts
          rows={[
            ['Access', src.ability],
            ['Used by', from.length ? from.join(', ') : undefined],
            ['Functions', src.functions.length ? src.functions.join(', ') : undefined],
            [
              src.hosts.length === 1 ? 'Address' : 'Addresses',
              src.hosts.length ? (
                <span className="bp-hosts">
                  {src.hosts.map((h) => (
                    <code key={h}>{h}</code>
                  ))}
                </span>
              ) : undefined
            ],
            ['Workspace', ws ? ws.displayName : undefined],
            ['Capacity', ws?.sku ? `${ws.sku}${ws.region ? ` · ${ws.region}` : ''}` : undefined],
            ['Model', model?.name],
            ['Model owner', model?.configuredBy],
            ['Workspace ID', src.workspaceId && <Guid value={src.workspaceId} />],
            ['Item ID', src.itemId && <Guid value={src.itemId} />],
            ['Connector', connector && <code>{connector.name}</code>],
            ['Type', connector && <code>{connector.type}</code>],
            ['auth.type', connector && <code>{connector.auth ?? 'not set'}</code>],
            ['fabric.yaml', src.modelAliases.length ? <code>{src.modelAliases.join(', ')}</code> : undefined]
          ]}
        />
      </Section>
      {audience && (
        <Section title="Grant the app">
          <p className="bp-insp-note">{audience.grant}</p>
        </Section>
      )}
      <DocLink href={audience ? DOCS.connections : src.kind === 'api' ? DOCS.secrets : DOCS.connectorAuth}>
        {audience ? 'Function connections' : src.kind === 'api' ? 'Secrets in functions' : 'Connector authentication'}
      </DocLink>
    </Panel>
  )
}
