import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type {
  LocalSecret,
  SecretEnvironment,
  SecretInfo,
  SecretsState,
  StudioProject
} from '@shared/ipc'
import { toLocalBackendError, type LocalBackendError } from '../localBackend'
import { Trans, translator, useTranslation } from '../i18n'
import { relativeTime } from './advisor/format'
import { Codicon } from './icons'
import Skeleton from './Skeleton'
import SecretDialog, { type SecretDialogTarget, type SecretSaved } from './secrets/SecretDialog'
import { secretEntries, type SecretEntry } from './secrets/entries'
import {
  copilotPrompt,
  EntryDetails,
  localValueState,
  publishedValueState,
  SecretDetails,
  SecretsOverview,
  SecretStatus,
  ValueStatus,
  type Check
} from './secrets/SecretPanels'
import './skills/skills.css'
import './secrets/secrets.css'

const ConfirmModal = lazy(() => import('./ConfirmModal'))

interface Props {
  project: StudioProject
  /** Called after `rayfin.yml` may have changed (a secret added or deleted), so History can refresh. */
  onChanged: () => void
  /** Stage a prompt in the Build chat (used by "Ask Copilot to use it"). */
  onSendToChat?: (display: string, prompt: string) => void
}

/** A `t` for the Secrets tab's words. */
type SecretsT = ReturnType<typeof translator<'secrets'>>

/** One deployment of a team app and its secrets. */
interface SecretGroup {
  key: string
  title: string
  hint: string
  secrets: SecretInfo[]
  /** Shown instead of rows: not deployed, why it failed, or that it has none. */
  message?: string
  /** The app in the Fabric portal (team apps change their secrets there). */
  portalUrl?: string
}

/** An environment's name and what it's for. */
function environmentText(
  kind: SecretEnvironment['kind'],
  t: SecretsT
): { title: string; hint: string } {
  switch (kind) {
    case 'published':
      return { title: t('environments.published.title'), hint: t('environments.published.hint') }
    case 'preview':
      return { title: t('environments.preview.title'), hint: t('environments.preview.hint') }
    default:
      return { title: kind, hint: '' }
  }
}

function environmentGroup(environment: SecretEnvironment, t: SecretsT): SecretGroup {
  const { title, hint } = environmentText(environment.kind, t)
  return {
    key: environment.kind,
    title,
    hint,
    secrets: environment.secrets,
    portalUrl: environment.portalUrl,
    message: !environment.deployed
      ? environment.kind === 'published'
        ? t('groups.notPublishedYet')
        : t('groups.notDeployedYet')
      : (environment.error ??
        (environment.secrets.length === 0 ? t('groups.noSecretsYet') : undefined))
  }
}

/** The values rayfin-local has on this computer: being read, read, or not readable. */
type LocalValues =
  | { status: 'loading' }
  | { status: 'ok'; secrets: LocalSecret[] }
  | { status: 'error'; error: LocalBackendError }

/** A team app's secret, read-only. */
function TeamSecretRow({
  secret,
  selected,
  onSelect
}: {
  secret: SecretInfo
  selected: boolean
  onSelect: () => void
}): JSX.Element {
  const { t } = useTranslation('secrets')
  const now = Date.now()
  return (
    <li>
      <button
        type="button"
        className={`sec-row${selected ? ' sec-row--selected' : ''}`}
        aria-pressed={selected}
        onClick={onSelect}
      >
        <span className="sec-mark" aria-hidden="true">
          <Codicon name="key" />
        </span>
        <span className="sec-row-text">
          <span className="sec-name">{secret.name}</span>
          {secret.description && <span className="sec-row-desc">{secret.description}</span>}
        </span>
        <SecretStatus secret={secret} />
        <span className="sec-row-time">
          {secret.updatedAt ? t('rows.changed', { time: relativeTime(secret.updatedAt, now) }) : ''}
        </span>
        <Codicon name="chevron-right" className="sec-row-chevron" />
      </button>
    </li>
  )
}

/** One of the app's secrets: its value on this computer and, once published, on the published app. */
function EntryRow({
  entry,
  localCheck,
  publishedCheck,
  selected,
  onSelect
}: {
  entry: SecretEntry
  localCheck: Check
  /** `null` while the app isn't published (or for a team app): there's no published column. */
  publishedCheck: Check | null
  selected: boolean
  onSelect: () => void
}): JSX.Element {
  const { t } = useTranslation('secrets')
  const local = localValueState(entry, localCheck)
  const published = publishedCheck && publishedValueState(entry, publishedCheck)
  const about = [entry.declared ? null : t('notInYml'), entry.description]
    .filter(Boolean)
    .join(' · ')
  return (
    <li>
      <button
        type="button"
        className={`sec-row${selected ? ' sec-row--selected' : ''}`}
        aria-pressed={selected}
        onClick={onSelect}
      >
        <span className="sec-mark" aria-hidden="true">
          <Codicon name="key" />
        </span>
        <span className="sec-row-text">
          <span className="sec-name">{entry.name}</span>
          {about && <span className="sec-row-desc">{about}</span>}
        </span>
        <span className="sec-cell">
          {local && (
            <>
              <span className="sr-only">{t('rows.localSr')} </span>
              <ValueStatus state={local} />
            </>
          )}
        </span>
        {publishedCheck && (
          <span className="sec-cell sec-cell--published">
            {published && (
              <>
                <span className="sr-only">{t('rows.publishedSr')} </span>
                <ValueStatus state={published} />
              </>
            )}
          </span>
        )}
        <Codicon name="chevron-right" className="sec-row-chevron" />
      </button>
    </li>
  )
}

/**
 * The Secrets tab: API keys, passwords and connection strings the app's Rayfin
 * functions read as `ctx.Secrets.NAME`. Names live in `rayfin.yml`. Each secret
 * has a value on this computer, which rayfin-local keeps for the app while it
 * runs here, and, once the app is published, a value on the published app.
 * Published values go through the app's Rayfin CLI (`rayfin secret`). Values
 * are write-only: the tab shows where each one comes from, never the value. A
 * team app's values on this computer work the same; its deployments are listed
 * read-only, and their secrets are changed in the portal.
 */
export default function SecretsView({ project, onChanged, onSendToChat }: Props): JSX.Element {
  const { t } = useTranslation('secrets')
  const [data, setData] = useState<SecretsState | null>(null)
  const [loading, setLoading] = useState(false)
  const [local, setLocal] = useState<LocalValues>({ status: 'loading' })
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** `<group>:<name>` of the selected secret (the app's own are `app`). */
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [dialog, setDialog] = useState<SecretDialogTarget | null>(null)
  /** A value to remove from this computer, or a secret to delete from the published app. */
  const [confirm, setConfirm] = useState<{
    kind: 'local' | 'published'
    entry: SecretEntry
  } | null>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const request = useRef(0)
  const localRequest = useRef(0)
  /** The dialog added a secret to rayfin.yml but didn't store its value. */
  const declaredInDialog = useRef(false)

  const load = useCallback(async () => {
    const id = ++request.current
    setLoading(true)
    try {
      const state = await window.api.secrets.list(project.id)
      if (id === request.current) setData(state)
    } catch (err) {
      if (id === request.current)
        setData({ status: 'error', secrets: [], functionsEnabled: false, error: String(err) })
    } finally {
      if (id === request.current) setLoading(false)
    }
  }, [project.id])

  // Every app, a team app too, has its values on this computer.
  const loadLocal = useCallback(async () => {
    const id = ++localRequest.current
    try {
      const secrets = await window.api.local.secrets(project.id)
      if (id === localRequest.current)
        setLocal({ status: 'ok', secrets: Array.isArray(secrets) ? secrets : [] })
    } catch (reason) {
      if (id === localRequest.current)
        setLocal({ status: 'error', error: toLocalBackendError(reason) })
    }
  }, [project.id])

  const reload = useCallback(() => {
    void load()
    void loadLocal()
  }, [load, loadLocal])

  useEffect(() => {
    setData(null)
    setLocal({ status: 'loading' })
    setSelectedKey(null)
  }, [project.id])

  // The list is read when the tab opens. A first publish (or a switch to another
  // deployment) changes which app the published values live on, so read it again then.
  const deployedUrl = project.lastDeploy?.url
  useEffect(() => {
    void load()
  }, [load, deployedUrl])

  useEffect(() => {
    void loadLocal()
  }, [loadLocal])

  useEffect(() => {
    return () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current)
    }
  }, [])

  const flash = useCallback((message: string) => {
    setNotice(message)
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(null), 3500)
  }, [])

  const status = data?.status
  const isTeam = status === 'team'
  /** The app's own secrets are listed: a team app's with their values on this computer. */
  const withEntries =
    status === 'ready' || status === 'error' || status === 'not-deployed' || isTeam
  /** Reading the values on this computer. */
  const localCheck: Check =
    local.status === 'ok' ? 'ok' : local.status === 'error' ? 'failed' : 'loading'
  // The published column: values read, or not readable. None before the first
  // publish, nor for a team app, whose deployments are listed apart.
  const publishedCheck: Check | null =
    status === 'ready' ? 'ok' : status === 'error' ? 'failed' : null
  /** A new secret's value goes to this computer. */
  const canAdd = withEntries

  const saved = useCallback(
    (name: string, what: SecretSaved) => {
      declaredInDialog.current = false
      setError(null)
      flash(
        what === 'added'
          ? isTeam
            ? t('flash.addedPortal', { name })
            : publishedCheck
              ? t('flash.addedToo', { name })
              : t('flash.addedLocal', { name })
          : what === 'local'
            ? t('flash.savedLocal', { name })
            : t('flash.savedPublished', { name })
      )
      setSelectedKey(`app:${name}`)
      if (what !== 'local') {
        onChanged()
        void load()
      }
      void loadLocal()
    },
    [flash, load, loadLocal, onChanged, publishedCheck, isTeam, t]
  )

  const closeDialog = useCallback(() => {
    setDialog(null)
    if (declaredInDialog.current) {
      declaredInDialog.current = false
      reload()
    }
  }, [reload])

  const confirmChange = useCallback(async () => {
    if (!confirm) return
    const { kind, entry } = confirm
    setConfirmBusy(true)
    setError(null)
    try {
      if (kind === 'local') {
        await window.api.local.deleteSecret(project.id, entry.name)
        flash(t('flash.removedLocal', { name: entry.name }))
        // A value rayfin.yml doesn't list goes away with it.
        if (!entry.declared && !entry.published?.stored) setSelectedKey(null)
        void loadLocal()
      } else {
        const result = await window.api.secrets.remove(project.id, entry.name)
        if (!result.ok) {
          setError(
            `${result.error ?? t('errors.deleteFailed')}${result.signIn ? ` ${t('signInHint')}` : ''}`
          )
          return
        }
        flash(t('flash.deletedPublished', { name: entry.name }))
        setSelectedKey(null)
        onChanged()
        reload()
      }
    } catch (reason) {
      const failure = toLocalBackendError(reason)
      setError(failure.hint ? `${failure.message} ${failure.hint}` : failure.message)
    } finally {
      setConfirmBusy(false)
      setConfirm(null)
    }
  }, [confirm, project.id, flash, loadLocal, onChanged, reload, t])

  const askCopilot = useCallback(
    (name: string, declared: boolean) =>
      onSendToChat?.(t('useChat', { name }), copilotPrompt(name, declared)),
    [onSendToChat, t]
  )

  // Esc closes the details, unless a dialog is open (it handles Esc itself).
  const dialogOpen = Boolean(dialog || confirm)
  useEffect(() => {
    if (!selectedKey || dialogOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) setSelectedKey(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedKey, dialogOpen])

  const entries = useMemo(
    () =>
      data && withEntries ? secretEntries(data, local.status === 'ok' ? local.secrets : null) : [],
    [data, withEntries, local]
  )
  const groups = useMemo<SecretGroup[]>(
    () =>
      isTeam
        ? (data?.environments ?? []).map((environment) => environmentGroup(environment, t))
        : [],
    [isTeam, data, t]
  )

  const selectedEntry = withEntries
    ? (entries.find((entry) => `app:${entry.name}` === selectedKey) ?? null)
    : null
  const teamSelection = useMemo(() => {
    for (const group of groups) {
      const secret = group.secrets.find((s) => `${group.key}:${s.name}` === selectedKey)
      if (secret) return { group, secret }
    }
    return null
  }, [groups, selectedKey])

  const empty = (title: string, body: JSX.Element | string, action?: JSX.Element): JSX.Element => (
    <div className="skl-empty sec-empty">
      <span className="sec-mark sec-mark--lg" aria-hidden="true">
        <Codicon name="key" />
      </span>
      <strong>{title}</strong>
      <span>{body}</span>
      {action}
    </div>
  )

  const teamSection = (group: SecretGroup): JSX.Element => (
    <section className="skl-group" aria-label={group.title} key={group.key}>
      <div className="skl-lane">
        <h3>{group.title}</h3>
        <span className="skl-lane-count">{group.secrets.length}</span>
        <span className="skl-lane-hint">{group.hint}</span>
        {group.portalUrl && (
          <button
            type="button"
            className="skl-link sec-lane-link"
            onClick={() => void window.api.openExternal(group.portalUrl ?? '')}
          >
            {t('openInFabric')} <Codicon name="link-external" />
          </button>
        )}
      </div>
      {group.message ? (
        <p className="sec-group-message">{group.message}</p>
      ) : (
        <ul className="sec-list">
          {group.secrets.map((secret) => {
            const key = `${group.key}:${secret.name}`
            return (
              <TeamSecretRow
                key={key}
                secret={secret}
                selected={key === selectedKey}
                onSelect={() => setSelectedKey((current) => (current === key ? null : key))}
              />
            )
          })}
        </ul>
      )}
    </section>
  )

  const publishedError = status === 'error' && (
    <div className="alert alert--error skl-error sec-alert" role="alert">
      <span>
        {t('errors.publishedRead')}
        {data?.error ? ` ${data.error}` : ''}
        {data?.signIn ? ` ${t('signInHint')}` : ''}
      </span>
      <button type="button" className="btn btn--sm" onClick={() => void load()} disabled={loading}>
        <Codicon name="refresh" /> {t('actions.tryAgain')}
      </button>
    </div>
  )

  const localError = local.status === 'error' && (
    <p className="skl-note sec-local-note">
      <Codicon name="info" />
      <span>
        {t('errors.localCheck', { message: local.error.message })}
        {local.error.hint ? ` ${local.error.hint}` : ''}
      </span>
    </p>
  )

  const newSecretButton = canAdd ? (
    <button
      type="button"
      className="btn btn--sm btn--primary"
      onClick={() => setDialog({ kind: 'new' })}
    >
      <Codicon name="add" /> {t('newSecret')}
    </button>
  ) : undefined
  /** The app's own secrets: their values on this computer and, once it's published, on the published app. */
  const entriesTable =
    entries.length === 0 ? (
      empty(t('empty.title'), t('empty.desc'), newSecretButton)
    ) : (
      <section className="skl-group" aria-label={t('list.label')}>
        <div className="skl-lane">
          <h3>{isTeam ? t('list.onThisComputer') : t('list.label')}</h3>
          <span className="skl-lane-count">{entries.length}</span>
          <span className="skl-lane-hint">{isTeam ? t('list.teamHint') : t('list.hint')}</span>
        </div>
        <div className="sec-table">
          <div className="sec-cols" aria-hidden="true">
            <span className="sec-cols-name">{t('list.secret')}</span>
            <span className="sec-cell">{t('values.local')}</span>
            {publishedCheck && (
              <span className="sec-cell sec-cell--published">{t('values.published')}</span>
            )}
            <span className="sec-cols-end" />
          </div>
          <ul className="sec-list">
            {entries.map((entry) => {
              const key = `app:${entry.name}`
              return (
                <EntryRow
                  key={key}
                  entry={entry}
                  localCheck={localCheck}
                  publishedCheck={publishedCheck}
                  selected={key === selectedKey}
                  onSelect={() => setSelectedKey((current) => (current === key ? null : key))}
                />
              )
            })}
          </ul>
        </div>
      </section>
    )

  let content: JSX.Element
  if (!data) {
    content = (
      <div className="skl-loading">
        <Skeleton rows={4} avatar />
      </div>
    )
  } else if (isTeam) {
    content = (
      <>
        {localError}
        {entriesTable}
        <p className="skl-note sec-team-note">
          <Codicon name="info" />
          <span>
            <Trans t={t} i18nKey="teamNote" components={{ b: <strong /> }} />
          </span>
        </p>
        {groups.map(teamSection)}
      </>
    )
  } else if (status === 'update-rayfin') {
    content = empty(
      t('updateRayfin.title'),
      data.rayfinVersion ? (
        <Trans
          t={t}
          i18nKey="updateRayfin.desc"
          values={{ version: data.rayfinVersion }}
          components={{ b: <strong /> }}
        />
      ) : (
        <Trans t={t} i18nKey="updateRayfin.descNoVersion" components={{ b: <strong /> }} />
      )
    )
  } else {
    content = (
      <>
        {publishedError}
        {localError}
        {entriesTable}
      </>
    )
  }

  const declared = entries.filter((entry) => entry.declared)
  const share = (count: number): string =>
    declared.length > 0 ? t('facts.share', { part: count, total: declared.length }) : '–'
  const setHere: [string, string] = [
    t('facts.setHere'),
    localCheck === 'ok'
      ? share(declared.filter((entry) => entry.local && entry.local !== 'none').length)
      : '–'
  ]
  const facts: [string, string][] = isTeam
    ? [
        [t('facts.secrets'), String(entries.length)],
        setHere,
        ...(data?.environments ?? []).map((env): [string, string] => [
          environmentText(env.kind, t).title,
          !env.deployed
            ? env.kind === 'published'
              ? t('facts.notPublished')
              : t('facts.notDeployed')
            : env.error
              ? '–'
              : String(env.secrets.filter((s) => s.stored).length)
        ])
      ]
    : withEntries
      ? [
          [t('facts.secrets'), String(entries.length)],
          setHere,
          [
            t('facts.setPublished'),
            publishedCheck === 'ok'
              ? share(declared.filter((entry) => entry.published?.stored).length)
              : publishedCheck === 'failed'
                ? '–'
                : t('facts.notPublishedYet')
          ]
        ]
      : []

  let side: JSX.Element | null = null
  if (selectedEntry) {
    side = (
      <EntryDetails
        key={`app:${selectedEntry.name}`}
        entry={selectedEntry}
        localCheck={localCheck}
        publishedCheck={publishedCheck}
        busy={loading}
        onClose={() => setSelectedKey(null)}
        onSetLocal={(entry) =>
          setDialog({
            kind: 'local',
            name: entry.name,
            replacing: entry.local === 'local' || entry.local === 'settings'
          })
        }
        onRemoveLocal={(entry) => setConfirm({ kind: 'local', entry })}
        onSetPublished={(entry) =>
          setDialog({
            kind: 'published',
            secret: entry.published ?? { name: entry.name, declared: entry.declared, stored: false }
          })
        }
        onDeletePublished={(entry) => setConfirm({ kind: 'published', entry })}
        onAskCopilot={onSendToChat ? (entry) => askCopilot(entry.name, entry.declared) : undefined}
      />
    )
  } else if (teamSelection) {
    side = (
      <SecretDetails
        key={`${teamSelection.group.key}:${teamSelection.secret.name}`}
        secret={teamSelection.secret}
        environment={teamSelection.group.title}
        portalUrl={teamSelection.group.portalUrl}
        onClose={() => setSelectedKey(null)}
        onAskCopilot={
          onSendToChat ? (secret) => askCopilot(secret.name, secret.declared) : undefined
        }
      />
    )
  } else if (data) {
    side = (
      <SecretsOverview
        facts={facts}
        functionsEnabled={data.functionsEnabled}
        team={isTeam}
        published={publishedCheck !== null}
      />
    )
  }

  const removing = confirm?.entry.name ?? ''

  return (
    <div className="skl sec">
      <header className="skl-head">
        <div className="skl-head-title">
          <span className="skl-head-glyph" aria-hidden="true">
            <Codicon name="key" />
          </span>
          <h2 className="skl-title">{t('title')}</h2>
          <span className="skl-subtitle">{t('subtitle')}</span>
        </div>
        <div className="skl-tools">
          <button
            type="button"
            className="model-tool-btn"
            onClick={reload}
            disabled={loading}
            aria-label={t('actions.refresh')}
            title={t('actions.refresh')}
          >
            <Codicon name="refresh" className={loading && data ? 'icon-spin' : undefined} />
          </button>
          <button
            type="button"
            className="model-tool-btn"
            onClick={() => setDialog({ kind: 'new' })}
            disabled={!canAdd}
            title={t('addTitle')}
          >
            <Codicon name="add" /> {t('newSecret')}
          </button>
        </div>
      </header>

      <div className="skl-body">
        <div className="skl-main" aria-busy={loading}>
          {notice && (
            <div className="skl-notice" role="status">
              <Codicon name="check" /> {notice}
            </div>
          )}
          {error && <div className="alert alert--error skl-error">{error}</div>}
          {content}
        </div>

        {side}
      </div>

      {dialog && (
        <SecretDialog
          projectId={project.id}
          target={dialog}
          existing={entries}
          onClose={closeDialog}
          onSaved={saved}
          onDeclared={() => {
            declaredInDialog.current = true
            onChanged()
          }}
        />
      )}

      {confirm && (
        <Suspense fallback={null}>
          {confirm.kind === 'local' ? (
            <ConfirmModal
              title={t('confirm.removeTitle')}
              message={
                confirm.entry.declared ? (
                  t('confirm.removeDeclared', { name: removing })
                ) : (
                  <Trans
                    t={t}
                    i18nKey="confirm.removeUnused"
                    values={{ name: removing }}
                    components={{ code: <code /> }}
                  />
                )
              }
              confirmLabel={t('actions.remove')}
              danger
              busy={confirmBusy}
              busyLabel={t('confirm.removing')}
              onConfirm={() => void confirmChange()}
              onCancel={() => (confirmBusy ? undefined : setConfirm(null))}
            />
          ) : (
            <ConfirmModal
              title={t('confirm.deleteTitle')}
              message={
                <Trans
                  t={t}
                  i18nKey="confirm.deleteMessage"
                  values={{ name: removing }}
                  components={{ code: <code /> }}
                />
              }
              confirmLabel={t('actions.delete')}
              danger
              busy={confirmBusy}
              busyLabel={t('status.deleting')}
              onConfirm={() => void confirmChange()}
              onCancel={() => (confirmBusy ? undefined : setConfirm(null))}
            />
          )}
        </Suspense>
      )}
    </div>
  )
}
