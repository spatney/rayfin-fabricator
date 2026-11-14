import { useEffect, useState, type CSSProperties, type ReactNode, type JSX } from 'react'
import type { SecretInfo, SecretsState, StudioProject } from '@shared/ipc'
import { Trans, translator, useTranslation } from '../../i18n'
import {
  audienceKind,
  connectorKind,
  connectorTypeLabel,
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
  /** Show a semantic model (`workspaceId:itemId`) or a SQL source's tables in the Fabric connections view. */
  onOpenFabricData: (key: string) => void
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
  const { t } = useTranslation('blueprint')
  return (
    <aside className="bp-insp" aria-label={t('inspector.panelAria', { title })}>
      <header className="bp-insp-head">
        {glyph}
        <div className="bp-insp-titles">
          <span className="bp-insp-kicker">{kicker}</span>
          <h3 className="bp-insp-title">{title}</h3>
        </div>
        <button
          type="button"
          className="bp-insp-close"
          onClick={onClose}
          aria-label={t('inspector.close')}
          title={t('inspector.closeTitle')}
        >
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
  const { t } = useTranslation('blueprint')
  return (
    <span className="bp-guid">
      <code title={value}>{value}</code>
      <CopyButton text={value} compact title={t('actions.copy')} className="bp-guid-copy" />
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
  const { t } = useTranslation('blueprint')
  return (
    <button type="button" className={`bp-signs bp-signs--${identity}`} onClick={() => onSelect(target)}>
      <span className={`bp-glyph bp-glyph--${identity}`} aria-hidden="true">
        <Codicon name={IDENTITY_ICON[identity]} />
      </span>
      <span className="bp-signs-text">
        <strong>{t(IDENTITY_LABEL[identity])}</strong>
        <span>
          {identity === 'user'
            ? t('inspector.signs.user')
            : identity === 'app'
              ? t('inspector.signs.app', { who: whoLabel(appIdentity) })
              : t('inspector.signs.key')}
        </span>
      </span>
      <Codicon name="chevron-right" className="bp-signs-go" />
    </button>
  )
}

/** Who the app identity is, in English: for prompts. */
function whoText(identity: AppIdentityInfo): string {
  if (identity.kind === 'service-principal') return `the service principal ${identity.who}`
  if (identity.kind === 'account' && identity.who) return identity.who
  return 'the owner of the Fabric app'
}

/** Who the app identity is, in the language shown. */
function whoLabel(identity: AppIdentityInfo): string {
  const t = translator('blueprint')
  if (identity.kind === 'service-principal') return t('inspector.who.servicePrincipal', { who: identity.who })
  if (identity.kind === 'account' && identity.who) return identity.who
  return t('inspector.who.owner')
}

function SourceList({ arch, sources, onSelect, grant }: {
  arch: AppArchitecture
  sources: SourceNode[]
  onSelect: (id: string) => void
  grant?: boolean
}): JSX.Element {
  const { t } = useTranslation('blueprint')
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
      {sources.length === 0 && (
        <li className="bp-list-empty">{arch.sources.length ? t('status.none') : t('inspector.nothingYet')}</li>
      )}
    </ul>
  )
}

function grantFor(s: SourceNode): string {
  if (s.audience) return audienceKind(s.audience).grant
  return translator('blueprint')('inspector.grantFabric')
}

/** One row that opens the Secrets part. */
function SecretsLink({ arch, onSelect }: { arch: AppArchitecture; onSelect: (id: string) => void }): JSX.Element {
  const { t } = useTranslation('blueprint')
  const n = arch.keys.secrets.length
  return (
    <ul className="bp-list">
      <li>
        <button type="button" className="bp-list-row" onClick={() => onSelect(ids.service('secrets'))}>
          <span className="bp-tile bp-tile--sm" aria-hidden="true">
            <Codicon name="lock" />
          </span>
          <span className="bp-list-text">
            <strong>{t('inspector.secretCount', { count: n })}</strong>
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
  const { t } = useTranslation('blueprint')
  const p = arch.people
  return (
    <Panel
      kicker={t('inspector.people.kicker')}
      title={t('view.people.title')}
      glyph={<Glyph icon="organization" tone="people" />}
      onClose={onClose}
      actions={
        <>
          {deploy.url && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => open(deploy.url!)}>
              <Codicon name="globe" /> {t('view.openApp')}
            </button>
          )}
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => onOpenFile('rayfin/rayfin.yml')}>
            {t('tab.openYml')}
          </button>
        </>
      }
    >
      <p className="bp-insp-lead">
        <Trans t={t} i18nKey="inspector.people.lead" components={{ strong: <strong /> }} />
      </p>
      <Issues issues={p.issues} />
      <Facts
        rows={[
          [t('inspector.facts.signIn'), p.signIn],
          [
            t('inspector.facts.pages'),
            arch.config.hosting.enabled &&
              (p.access === 'public'
                ? t('inspector.people.loadBefore')
                : p.access === 'protected'
                  ? t('inspector.people.loadAfter')
                  : t('inspector.notSetYet'))
          ],
          [
            t('inspector.facts.opens'),
            p.embeddedOnly ? t('inspector.people.onlyInPortal') : t('inspector.opensEverywhere')
          ],
          [t('inspector.facts.address'), deploy.url && host(deploy.url)]
        ]}
      />
      <DocLink href={DOCS.signIn}>{t('inspector.docs.signInPeople')}</DocLink>
    </Panel>
  )
}

function AppDetails({ arch, project, deploy, workspaceName, onClose, onOpenFile, onSelect }: Props): JSX.Element {
  const { t } = useTranslation('blueprint')
  return (
    <Panel
      kicker={t('view.app.fabricApp')}
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
              <Codicon name="globe" /> {t('view.openApp')}
            </button>
          )}
          {deploy.portalUrl && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => open(deploy.portalUrl!)}>
              <Codicon name="link-external" /> {t('view.openInFabric')}
            </button>
          )}
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => onOpenFile('rayfin/rayfin.yml')}>
            {t('tab.openYml')}
          </button>
        </>
      }
    >
      <p className="bp-insp-lead">
        <Trans t={t} i18nKey="inspector.app.lead" components={{ code: <code /> }} />
      </p>
      <Facts
        rows={[
          [t('inspector.facts.workspace'), workspaceName],
          [t('inspector.facts.address'), deploy.url ? host(deploy.url) : t('inspector.app.notPublished')],
          [t('inspector.facts.lastPublished'), project.lastDeploy?.at && relativeTime(project.lastDeploy.at)],
          [t('inspector.facts.project'), project.path]
        ]}
      />
      <Section title={t('inspector.app.parts')}>
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
  const { t } = useTranslation('blueprint')
  // From a part's port: only what that part reaches this way.
  const sources = arch.sources.filter((s) =>
    via
      ? arch.routes.some((r) => r.service === via.id && r.identity === identity && r.source === s.id)
      : s.identity === identity
  )
  const kicker = via ? via.title : t('inspector.identity.kicker')
  const title = t(via ? PORT_LABEL[identity] : IDENTITY_LABEL[identity])
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
              <Codicon name="sparkle" /> {t('inspector.moveKeys')}
            </button>
          )
        }
      >
        <p className="bp-insp-lead">{t('inspector.identity.keyLead')}</p>
        <Issues
          issues={keys.hardcoded.length ? [{ tone: 'danger', text: hardcodedSummary(keys.hardcoded) }] : []}
        />
        <Section title={t('inspector.identity.reachedWithKey')}>
          <SourceList arch={arch} sources={sources} onSelect={onSelect} />
        </Section>
        <Section title={t('inspector.identity.secretsUsed')}>
          {keys.secrets.length ? (
            <SecretsLink arch={arch} onSelect={onSelect} />
          ) : (
            <p className="bp-insp-note">
              <Trans
                t={t}
                i18nKey="inspector.identity.noSecrets"
                components={{ strong: <strong />, code: <code /> }}
              />
            </p>
          )}
        </Section>
        <DocLink href={DOCS.secrets}>{t('inspector.docs.secrets')}</DocLink>
      </Panel>
    )
  }
  if (identity === 'user') {
    return (
      <Panel kicker={kicker} title={title} glyph={<Glyph icon={IDENTITY_ICON.user} tone="user" />} onClose={onClose}>
        <p className="bp-insp-lead">
          <Trans t={t} i18nKey="inspector.identity.userLead" components={{ strong: <strong /> }} />
        </p>
        <Section title={t('inspector.identity.everyoneNeeds')}>
          <SourceList arch={arch} sources={sources} onSelect={onSelect} />
        </Section>
        <p className="bp-insp-note">{t('inspector.identity.userNote')}</p>
        <DocLink href={DOCS.identities}>{t('inspector.docs.identities')}</DocLink>
      </Panel>
    )
  }
  return (
    <Panel
      kicker={via ? kicker : arch.name}
      title={via ? title : t('identity.app')}
      glyph={<Glyph icon={IDENTITY_ICON.app} tone="app" />}
      onClose={onClose}
      actions={
        sources.length > 0 && (
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => onPrompt(grantAppAccess(whoText(appIdentity), sources.map((s) => s.title)))}
          >
            <Codicon name="sparkle" /> {t('inspector.identity.askGrant')}
          </button>
        )
      }
    >
      <p className="bp-insp-lead">
        <Trans
          t={t}
          i18nKey={via ? 'inspector.identity.appLeadVia' : 'inspector.identity.appLead'}
          components={{ strong: <strong /> }}
        />
      </p>
      <Section title={t('inspector.identity.whose')}>
        <div className="bp-who">
          <span className={`bp-who-avatar${appIdentity.kind === 'service-principal' ? ' bp-who-avatar--sp' : ''}`}>
            <Codicon name={appIdentity.kind === 'service-principal' ? 'server-process' : 'account'} />
          </span>
          <div className="bp-who-text">
            <strong>{appIdentityName(appIdentity, Boolean(deploy.url))}</strong>
            <span>
              {appIdentity.kind === 'service-principal'
                ? t('inspector.identity.whoServicePrincipal')
                : appIdentity.kind === 'account'
                  ? t('inspector.identity.whoAccount')
                  : t('inspector.identity.whoOwner')}
            </span>
          </div>
        </div>
        {appIdentity.clientId && (
          <Facts rows={[[t('inspector.facts.clientId'), <Guid value={appIdentity.clientId} />]]} />
        )}
        {appIdentity.preview && (
          <p className="bp-insp-note">
            <Trans
              t={t}
              i18nKey="inspector.identity.previews"
              values={{ who: appIdentity.preview.who }}
              components={{ strong: <strong /> }}
            />
          </p>
        )}
        {appIdentity.kind === 'account' && <p className="bp-insp-note">{t('inspector.identity.ownerNote')}</p>}
      </Section>
      <Section title={t('inspector.identity.grantTo')}>
        <SourceList arch={arch} sources={sources} onSelect={onSelect} grant />
      </Section>
      {arch.functions && sources.some((s) => s.audience) && (
        <p className="bp-insp-note">{t('inspector.identity.localNote')}</p>
      )}
      <DocLink href={DOCS.identities}>{t('inspector.docs.identities')}</DocLink>
    </Panel>
  )
}

function ServiceDetails(props: Props & { svc: ServiceNode }): JSX.Element {
  const { arch, svc, deploy, onClose, onSelect, onOpenFile, onPrompt, onOpenEntity } = props
  const { t } = useTranslation('blueprint')
  const reached = arch.routes.filter((r) => r.service === svc.id).map((r) => r.source)
  const sources = arch.sources.filter((s) => reached.includes(s.id))
  const yml = (
    <button type="button" className="btn btn--sm btn--ghost" onClick={() => onOpenFile('rayfin/rayfin.yml')}>
      {t('tab.openYml')}
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
        t('inspector.website.lead'),
        <>
          <Facts
            rows={[
              [
                t('inspector.website.pagesLoad'),
                arch.people.access === 'public'
                  ? t('inspector.website.before')
                  : arch.people.access === 'protected'
                    ? t('inspector.website.after')
                    : t('inspector.notSetYet')
              ],
              [
                t('inspector.facts.setting'),
                <code>assetAccess: {arch.config.hosting.assetAccess ?? t('inspector.notSet')}</code>
              ],
              [
                t('inspector.facts.opens'),
                arch.config.hosting.embeddedOnly ? t('inspector.website.onlyInFabric') : t('inspector.opensEverywhere')
              ],
              [
                t('inspector.facts.buildOutput'),
                arch.config.hosting.folder && <code>{arch.config.hosting.folder}</code>
              ],
              [t('inspector.facts.address'), deploy.url && host(deploy.url)]
            ]}
          />
          {arch.people.access === 'public' && (
            <p className="bp-insp-note">
              <Trans t={t} i18nKey="inspector.website.publicNote" components={{ code: <code /> }} />
            </p>
          )}
          {arch.people.access === 'protected' && (
            <p className="bp-insp-note">{t('inspector.website.protectedNote')}</p>
          )}
          {sources.length > 0 && (
            <Section title={t('inspector.website.readsInBrowser')}>
              <SourceList arch={arch} sources={sources} onSelect={onSelect} />
            </Section>
          )}
          <DocLink href={DOCS.hosting}>{t('inspector.docs.hosting')}</DocLink>
        </>
      )
    case 'signin': {
      const uris = arch.config.auth.redirectUris
      return frame(
        t('inspector.signin.lead'),
        <>
          <Facts
            rows={[
              [t('inspector.facts.provider'), arch.people.signIn],
              [
                t('inspector.facts.externalTokens'),
                arch.config.auth.enabled &&
                  (arch.config.auth.externalEntraExchange
                    ? t('inspector.signin.accepted')
                    : t('inspector.signin.notAccepted'))
              ]
            ]}
          />
          {uris.length > 0 && (
            <Section title={t('inspector.signin.addresses')}>
              <ul className="bp-plain">
                {uris.slice(0, 6).map((u) => (
                  <li key={u}>
                    <code>{u}</code>
                  </li>
                ))}
                {uris.length > 6 && (
                  <li className="bp-insp-note">{t('inspector.signin.more', { count: uris.length - 6 })}</li>
                )}
              </ul>
            </Section>
          )}
          <DocLink href={DOCS.signIn}>{t('model.signin.title')}</DocLink>
        </>
      )
    }
    case 'database': {
      const db = arch.database
      const loose = (db?.tables ?? []).filter((table) => table.tone !== 'ok')
      return frame(
        <Trans t={t} i18nKey="inspector.database.lead" components={{ strong: <strong /> }} />,
        <>
          <Section title={t('inspector.database.tables', { count: db?.tables.length ?? 0 })}>
            <ul className="bp-list">
              {(db?.tables ?? []).map((table) => (
                <li key={table.entity}>
                  <button type="button" className="bp-list-row" onClick={() => onOpenEntity(table.entity)}>
                    <span className={`bp-dot bp-dot--${table.tone}`} aria-hidden="true" />
                    <span className="bp-list-text">
                      <strong>{table.name}</strong>
                      <span>{table.accessLabel}</span>
                    </span>
                    <span className="bp-list-hint">{t('tab.dataModel')}</span>
                    <Codicon name="chevron-right" className="bp-list-go" />
                  </button>
                </li>
              ))}
              {!db?.tables.length && <li className="bp-list-empty">{t('model.database.noTables')}</li>}
            </ul>
          </Section>
          <DocLink href={DOCS.permissions}>{t('inspector.docs.permissions')}</DocLink>
        </>,
        <>
          {loose.length > 0 && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => onPrompt(hardenTables(loose))}>
              <Codicon name="shield" /> {t('inspector.database.harden')}
            </button>
          )}
          {db?.tables.length ? (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => onOpenEntity('')}>
              {t('inspector.database.openModel')}
            </button>
          ) : null}
        </>
      )
    }
    case 'storage':
      return frame(t('inspector.storage.lead'), <DocLink href={DOCS.storage}>{t('inspector.docs.storage')}</DocLink>)
    case 'functions': {
      const fns = arch.functions
      // Only a wrong `services.functions.auth.type` is this fix; keys in the code have their own.
      const authIssue =
        arch.config.functions.enabled && arch.config.functions.authType?.toLowerCase() !== 'application'
      return frame(
        <Trans t={t} i18nKey="inspector.functions.lead" components={{ strong: <strong /> }} />,
        <>
          <Section
            title={
              fns?.functions.length
                ? t('inspector.functions.count', { count: fns.functions.length })
                : t('model.functions.title')
            }
          >
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
              {!fns?.functions.length && <li className="bp-insp-note">{t('inspector.functions.none')}</li>}
            </ul>
          </Section>
          {sources.length > 0 && (
            <Section title={t('inspector.functions.reaches')}>
              <SourceList arch={arch} sources={sources} onSelect={onSelect} />
            </Section>
          )}
          {arch.keys.secrets.length > 0 && (
            <Section title={t('model.secrets.title')}>
              <SecretsLink arch={arch} onSelect={onSelect} />
            </Section>
          )}
          <DocLink href={DOCS.connections}>{t('inspector.docs.connections')}</DocLink>
        </>,
        <>
          {authIssue && (
            <button type="button" className="btn btn--sm btn--primary" onClick={() => onPrompt(fixFunctionsAuth())}>
              <Codicon name="sparkle" /> {t('inspector.fixWithCopilot')}
            </button>
          )}
          {!authIssue && arch.keys.hardcoded.length > 0 && (
            <button
              type="button"
              className="btn btn--sm btn--primary"
              onClick={() => onPrompt(moveKeysToSecrets(arch.keys.hardcoded))}
            >
              <Codicon name="sparkle" /> {t('inspector.moveKeys')}
            </button>
          )}
          {fns?.files[0] && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => onOpenFile(fns.files[0])}>
              {t('inspector.functions.openCode')}
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
        <Trans t={t} i18nKey="inspector.connectors.lead" components={{ code: <code /> }} />,
        <>
          <Section title={t('model.connectors.title')}>
            <SourceList arch={arch} sources={sources} onSelect={onSelect} />
          </Section>
          <DocLink href={DOCS.connectorAuth}>{t('inspector.docs.connectorAuth')}</DocLink>
        </>
      )
  }
}

/** What the published app holds, for the Secrets panel: by name, or why it can't say. */
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
  const { t } = useTranslation('blueprint')
  const stored = useStoredSecrets(project.id)
  const known = stored.status === 'ready' || stored.status === 'team'
  const byName = stored.status === 'loading' ? new Map<string, SecretInfo>() : stored.byName
  // Values the published app holds that neither rayfin.yml nor the code mention.
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
      title={t('model.secrets.title')}
      glyph={<Glyph icon={svc.icon} tone={svc.tone ?? 'neutral'} />}
      onClose={onClose}
      actions={
        <>
          {hardcoded.length > 0 && (
            <button type="button" className="btn btn--sm btn--primary" onClick={() => onPrompt(moveKeysToSecrets(hardcoded))}>
              <Codicon name="sparkle" /> {t('inspector.moveKeys')}
            </button>
          )}
          {onOpenSecrets && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={onOpenSecrets}>
              <Codicon name="lock" /> {t('inspector.secrets.manage')}
            </button>
          )}
          {legacy.length > 0 && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => onPrompt(readTypedSecrets(legacy))}>
              <Codicon name="sparkle" /> {t('inspector.secrets.readTyped')}
            </button>
          )}
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => onOpenFile('rayfin/rayfin.yml')}>
            {t('tab.openYml')}
          </button>
        </>
      }
    >
      <p className="bp-insp-lead">
        <Trans t={t} i18nKey="inspector.secrets.lead" components={{ code: <code /> }} />
      </p>
      <Issues
        issues={[
          ...svc.issues,
          ...(hardcoded.length ? [{ tone: 'danger' as const, text: hardcodedSummary(hardcoded) }] : []),
          ...(missing.length
            ? [
                {
                  tone: 'warn' as const,
                  text: t('inspector.secrets.noValue', {
                    count: missing.length,
                    names: missing.map((s) => `\`${s.name}\``).join(', ')
                  })
                }
              ]
            : [])
        ]}
      />
      <Section title={t('inspector.secretCount', { count: arch.keys.secrets.length })}>
        <ul className="bp-list">
          {arch.keys.secrets.map((s) => {
            const info = byName.get(s.name)
            const readBy = s.functions.length
              ? t('inspector.secrets.readBy', { functions: s.functions.join(', ') })
              : s.files.length
                ? t('inspector.secrets.readIn', { files: s.files.map((f) => f.split('/').pop()).join(', ') })
                : t('inspector.secrets.unread')
            const body = (
              <>
                <span className="bp-tile bp-tile--sm" aria-hidden="true">
                  <Codicon name="key" />
                </span>
                <span className="bp-list-text">
                  <strong className="bp-mono">{s.name}</strong>
                  {s.description && <span>{s.description}</span>}
                  <span className="bp-list-sub">
                    {s.declared ? readBy : t('inspector.secrets.undeclared', { readBy })}
                  </span>
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
                    title={t('actions.openNamed', { name: s.files[0] })}
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
                  <span className="bp-list-sub">{t('inspector.secrets.publishedOnly')}</span>
                </span>
                <SecretStatus secret={s} />
              </div>
            </li>
          ))}
        </ul>
        <p className="bp-insp-note">
          {stored.status === 'loading'
            ? t('inspector.secrets.status.loading')
            : stored.status === 'not-deployed'
              ? t('inspector.secrets.status.notDeployed')
              : stored.status === 'team'
                ? t('inspector.secrets.status.team')
                : stored.status === 'update-rayfin'
                  ? t('inspector.secrets.status.updateRayfin')
                  : stored.status === 'error'
                    ? stored.signIn
                      ? t('inspector.secrets.status.errorSignIn')
                      : t('inspector.secrets.status.error')
                    : stored.status === 'ready'
                      ? t('inspector.secrets.status.ready')
                      : null}
        </p>
      </Section>
      {sentTo.length > 0 && (
        <Section title={t('inspector.secrets.calledFrom')}>
          <SourceList arch={arch} sources={sentTo} onSelect={onSelect} />
        </Section>
      )}
      <p className="bp-insp-note">{t('inspector.secrets.localNote')}</p>
      <DocLink href={DOCS.secrets}>{t('inspector.docs.secrets')}</DocLink>
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
  onOpenFabricData
}: Props & { src: SourceNode }): JSX.Element {
  const { t } = useTranslation('blueprint')
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
          <Codicon name="sparkle" /> {t('inspector.fixWithCopilot')}
        </button>
      )}
      {src.suggestedAudience && (
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={() => onPrompt(reachAsTheApp(src.title, src.suggestedAudience!, src.hosts, src.files))}
        >
          <Codicon name="sparkle" /> {t('inspector.source.useApp')}
        </button>
      )}
      {src.semanticKey && (
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => onOpenFabricData(src.semanticKey!)}>
          <Codicon name="graph" /> {t('inspector.source.viewModel')}
        </button>
      )}
      {src.tablesKey && (
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => onOpenFabricData(src.tablesKey!)}>
          <Codicon name="table" /> {t('inspector.source.viewTables')}
        </button>
      )}
      {(model?.webUrl || workspaceUrl) && (
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => open(model?.webUrl ?? workspaceUrl!)}>
          <Codicon name="link-external" /> {t('view.openInFabric')}
        </button>
      )}
      {!badAuth && connector && kind?.category === 'A' && (
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={() => onPrompt(src.identity === 'app' ? runAsEachPerson(connector) : runAsTheApp(connector))}
        >
          <Codicon name="sparkle" />{' '}
          {src.identity === 'app' ? t('inspector.source.useUser') : t('inspector.source.useApp')}
        </button>
      )}
      {src.files.map((f) => (
        <button key={f} type="button" className="btn btn--sm btn--ghost" onClick={() => onOpenFile(f)}>
          {t('actions.openNamed', { name: f.split('/').pop() })}
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
          <Trans
            t={t}
            i18nKey="inspector.source.audienceLead"
            values={{ detail: audience.detail, audience: src.audience }}
            components={{ code: <code /> }}
          />
        </p>
      )}
      {src.kind === 'api' && <p className="bp-insp-lead">{t('inspector.source.apiLead')}</p>}
      {src.suggestedAudience && (
        <div className="bp-issue bp-issue--info">
          <Codicon name="lightbulb" />
          <span>
            <Trans
              t={t}
              i18nKey="inspector.source.suggested"
              values={{ title: src.title, audience: src.suggestedAudience }}
              components={{ code: <code /> }}
            />
          </span>
        </div>
      )}
      <Section title={t('inspector.identity.kicker')}>
        <SignsInAs identity={src.identity} appIdentity={appIdentity} target={signsTarget} onSelect={onSelect} />
        {connector && kind?.category === 'B' && (
          <p className="bp-insp-note">
            {t('inspector.source.alwaysUser', { kind: connectorTypeLabel(connector.type) })}
          </p>
        )}
        {connector && kind?.category === 'A' && (
          <p className="bp-insp-note">
            {src.identity === 'app' ? t('inspector.source.sameRows') : t('inspector.source.ownAccess')}
          </p>
        )}
      </Section>
      <Section title={t('inspector.source.details')}>
        <Facts
          rows={[
            [t('inspector.facts.access'), src.ability],
            [t('inspector.facts.usedBy'), from.length ? from.join(', ') : undefined],
            [t('model.functions.title'), src.functions.length ? src.functions.join(', ') : undefined],
            [
              t('inspector.facts.addresses', { count: src.hosts.length }),
              src.hosts.length ? (
                <span className="bp-hosts">
                  {src.hosts.map((h) => (
                    <code key={h}>{h}</code>
                  ))}
                </span>
              ) : undefined
            ],
            [t('inspector.facts.workspace'), ws ? ws.displayName : undefined],
            [t('inspector.facts.capacity'), ws?.sku ? `${ws.sku}${ws.region ? ` · ${ws.region}` : ''}` : undefined],
            [t('inspector.facts.model'), model?.name],
            [t('inspector.facts.modelOwner'), model?.configuredBy],
            [t('inspector.facts.workspaceId'), src.workspaceId && <Guid value={src.workspaceId} />],
            [t('inspector.facts.itemId'), src.itemId && <Guid value={src.itemId} />],
            [t('inspector.facts.connector'), connector && <code>{connector.name}</code>],
            [t('inspector.facts.type'), connector && <code>{connector.type}</code>],
            ['auth.type', connector && <code>{connector.auth ?? t('inspector.notSet')}</code>],
            ['fabric.yaml', src.modelAliases.length ? <code>{src.modelAliases.join(', ')}</code> : undefined]
          ]}
        />
      </Section>
      {audience && (
        <Section title={t('inspector.source.grantApp')}>
          <p className="bp-insp-note">{audience.grant}</p>
        </Section>
      )}
      <DocLink href={audience ? DOCS.connections : src.kind === 'api' ? DOCS.secrets : DOCS.connectorAuth}>
        {audience
          ? t('inspector.docs.connections')
          : src.kind === 'api'
            ? t('inspector.docs.secrets')
            : t('inspector.docs.connectorAuth')}
      </DocLink>
    </Panel>
  )
}
