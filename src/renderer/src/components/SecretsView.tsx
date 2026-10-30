import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type {
  LocalSecret,
  SecretEnvironment,
  SecretInfo,
  SecretsState,
  StudioProject
} from '@shared/ipc'
import { toLocalBackendError, type LocalBackendError } from '../localBackend'
import { useLocalDevelopment } from '../localDevelopment'
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

const SIGN_IN_HINT =
  'Your Fabric sign-in may have expired: open the account menu and select Refresh Fabric authentication, then try again.'

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

const ENVIRONMENT: Record<SecretEnvironment['kind'], { title: string; hint: string }> = {
  published: { title: 'Published app', hint: 'What everyone on the team uses' },
  preview: { title: 'Your preview', hint: 'Your changes, deployed for you' }
}

function environmentGroup(environment: SecretEnvironment): SecretGroup {
  const { title, hint } = ENVIRONMENT[environment.kind] ?? { title: environment.kind, hint: '' }
  return {
    key: environment.kind,
    title,
    hint,
    secrets: environment.secrets,
    portalUrl: environment.portalUrl,
    message: !environment.deployed
      ? environment.kind === 'published'
        ? 'Not published yet.'
        : 'Not deployed yet. Your preview’s secrets show here once the pipeline deploys it.'
      : (environment.error ?? (environment.secrets.length === 0 ? 'No secrets yet.' : undefined))
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
          {secret.updatedAt ? `Changed ${relativeTime(secret.updatedAt, now)}` : ''}
        </span>
        <Codicon name="chevron-right" className="sec-row-chevron" />
      </button>
    </li>
  )
}

/** A personal app's secret: its value on this computer (with Local development) and, once published, on the published app. */
function EntryRow({
  entry,
  localCheck,
  publishedCheck,
  selected,
  onSelect
}: {
  entry: SecretEntry
  /** `null` without Local development: there's no local column. */
  localCheck: Check | null
  /** `null` while the app isn't published: there's no published column. */
  publishedCheck: Check | null
  selected: boolean
  onSelect: () => void
}): JSX.Element {
  const local = localCheck && localValueState(entry, localCheck)
  const published = publishedCheck && publishedValueState(entry, publishedCheck)
  const about = [entry.declared ? null : 'Not in rayfin.yml', entry.description]
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
        {localCheck && (
          <span className="sec-cell">
            {local && (
              <>
                <span className="sr-only">Local value: </span>
                <ValueStatus state={local} />
              </>
            )}
          </span>
        )}
        {publishedCheck && (
          <span className="sec-cell sec-cell--published">
            {published && (
              <>
                <span className="sr-only">Published value: </span>
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
 * functions read as `ctx.Secrets.NAME`. Names live in `rayfin.yml`. With Local
 * development, each secret has a value on this computer, which rayfin-local
 * keeps for the app while it runs here, and, once the app is published, a value
 * on the published app. Without it, there's only the published app's value, so
 * secrets wait for the first publish. Published values go through the app's
 * Rayfin CLI (`rayfin secret`). Values are write-only: the tab shows where each
 * one comes from, never the value. A team app's deployments are listed
 * read-only; their secrets are changed in the portal.
 */
export default function SecretsView({ project, onChanged, onSendToChat }: Props): JSX.Element {
  const [data, setData] = useState<SecretsState | null>(null)
  const [loading, setLoading] = useState(false)
  const [local, setLocal] = useState<LocalValues>({ status: 'loading' })
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** `<group>:<name>` of the selected secret (a personal app's group is `app`). */
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
  const team = Boolean(project.team)
  /** Values on this computer: a personal app's, with Local development. */
  const withLocal = useLocalDevelopment() && !team

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

  // Only an app that runs on this computer has values here: not a team app, nor
  // any app without Local development.
  const loadLocal = useCallback(async () => {
    if (!withLocal) return
    const id = ++localRequest.current
    try {
      const secrets = await window.api.local.secrets(project.id)
      if (id === localRequest.current)
        setLocal({ status: 'ok', secrets: Array.isArray(secrets) ? secrets : [] })
    } catch (reason) {
      if (id === localRequest.current)
        setLocal({ status: 'error', error: toLocalBackendError(reason) })
    }
  }, [project.id, withLocal])

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
  // Without Local development, secrets live on the published app alone, so an
  // app that isn't published yet has none to show.
  const waitsForPublish = !withLocal && status === 'not-deployed'
  const personal =
    status === 'ready' || status === 'error' || (status === 'not-deployed' && withLocal)
  const isTeam = status === 'team'
  /** Reading the values on this computer; `null` without them (no Local development). */
  const localCheck: Check | null = !withLocal
    ? null
    : local.status === 'ok'
      ? 'ok'
      : local.status === 'error'
        ? 'failed'
        : 'loading'
  // The published column: values read, or not readable. None before the first publish.
  const publishedCheck: Check | null =
    status === 'ready' ? 'ok' : status === 'error' ? 'failed' : null
  /** A new secret's value goes to this computer, or without it to the published app. */
  const canAdd = withLocal ? personal : status === 'ready'

  const saved = useCallback(
    (name: string, what: SecretSaved) => {
      declaredInDialog.current = false
      setError(null)
      flash(
        what === 'added'
          ? withLocal
            ? `Added ${name}, with its value on this computer.${publishedCheck ? ' Set its published value too.' : ''}`
            : `Added ${name}. Its value is stored with your published app.`
          : what === 'local'
            ? `Saved the value of ${name} on this computer.`
            : `Saved a new value for ${name} on your published app.`
      )
      setSelectedKey(`app:${name}`)
      if (what !== 'local') {
        onChanged()
        void load()
      }
      void loadLocal()
    },
    [flash, load, loadLocal, onChanged, publishedCheck, withLocal]
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
        flash(`Removed the value of ${entry.name} from this computer.`)
        // A value rayfin.yml doesn't list goes away with it.
        if (!entry.declared && !entry.published?.stored) setSelectedKey(null)
        void loadLocal()
      } else {
        const result = await window.api.secrets.remove(project.id, entry.name)
        if (!result.ok) {
          setError(
            `${result.error ?? 'Couldn’t delete the secret.'}${result.signIn ? ` ${SIGN_IN_HINT}` : ''}`
          )
          return
        }
        flash(`Deleted ${entry.name} from your published app.`)
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
  }, [confirm, project.id, flash, loadLocal, onChanged, reload])

  const askCopilot = useCallback(
    (name: string, declared: boolean) =>
      onSendToChat?.(`Use secret ${name}`, copilotPrompt(name, declared)),
    [onSendToChat]
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
      data && personal ? secretEntries(data, local.status === 'ok' ? local.secrets : null) : [],
    [data, personal, local]
  )
  const groups = useMemo<SecretGroup[]>(
    () => (isTeam ? (data?.environments ?? []).map(environmentGroup) : []),
    [isTeam, data]
  )

  const selectedEntry = personal
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
            Open in Fabric <Codicon name="link-external" />
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
        Couldn’t read your published app’s secrets.
        {data?.error ? ` ${data.error}` : ''}
        {data?.signIn ? ` ${SIGN_IN_HINT}` : ''}
      </span>
      <button type="button" className="btn btn--sm" onClick={() => void load()} disabled={loading}>
        <Codicon name="refresh" /> Try again
      </button>
    </div>
  )

  const localError = local.status === 'error' && (
    <p className="skl-note sec-local-note">
      <Codicon name="info" />
      <span>
        Couldn’t check the values on this computer. {local.error.message}
        {local.error.hint ? ` ${local.error.hint}` : ''}
      </span>
    </p>
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
        <p className="skl-note sec-team-note">
          <Codicon name="info" />
          <span>
            This app is in a team workspace, so Fabricator shows its secrets but can’t change them
            yet. Change them in the Fabric portal: use <strong>Open in Fabric</strong> next to the
            published app or your preview.
          </span>
        </p>
        {groups.map(teamSection)}
      </>
    )
  } else if (status === 'update-rayfin') {
    content = empty(
      'Update Rayfin to use secrets',
      <>
        Secrets need Rayfin 1.36 or newer
        {data.rayfinVersion ? `, and this app uses Rayfin ${data.rayfinVersion}` : ''}. Select
        Rayfin in the status bar and choose <strong>Update with Copilot</strong>.
      </>
    )
  } else if (waitsForPublish) {
    content = empty(
      'Publish your app first',
      'Secrets are stored with your published app, so you can add them once it’s published.'
    )
  } else if (entries.length === 0) {
    content = (
      <>
        {publishedError}
        {localError}
        {empty(
          'No secrets yet',
          'Add API keys, passwords and connection strings your functions need. Their values never go into your code.',
          canAdd ? (
            <button
              type="button"
              className="btn btn--sm btn--primary"
              onClick={() => setDialog({ kind: 'new', published: !withLocal })}
            >
              <Codicon name="add" /> New secret
            </button>
          ) : undefined
        )}
      </>
    )
  } else {
    content = (
      <>
        {publishedError}
        {localError}
        <section className="skl-group" aria-label="Secrets">
          <div className="skl-lane">
            <h3>Secrets</h3>
            <span className="skl-lane-count">{entries.length}</span>
            <span className="skl-lane-hint">
              Values never show here. To change one, set a new one.
            </span>
          </div>
          <div className="sec-table">
            <div className="sec-cols" aria-hidden="true">
              <span className="sec-cols-name">Secret</span>
              {localCheck && <span className="sec-cell">Local value</span>}
              {publishedCheck && (
                <span className="sec-cell sec-cell--published">Published value</span>
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
      </>
    )
  }

  const declared = entries.filter((entry) => entry.declared)
  const share = (count: number): string =>
    declared.length > 0 ? `${count} of ${declared.length}` : '–'
  const facts: [string, string][] = isTeam
    ? (data?.environments ?? []).map((env) => [
        ENVIRONMENT[env.kind]?.title ?? env.kind,
        !env.deployed
          ? env.kind === 'published'
            ? 'Not published'
            : 'Not deployed'
          : env.error
            ? '–'
            : String(env.secrets.filter((s) => s.stored).length)
      ])
    : personal
      ? [
          ['Secrets', String(entries.length)],
          ...(localCheck
            ? ([
                [
                  'Set on this computer',
                  localCheck === 'ok'
                    ? share(
                        declared.filter((entry) => entry.local && entry.local !== 'none').length
                      )
                    : '–'
                ]
              ] as [string, string][])
            : []),
          [
            'Set on the published app',
            publishedCheck === 'ok'
              ? share(declared.filter((entry) => entry.published?.stored).length)
              : publishedCheck === 'failed'
                ? '–'
                : 'Not published yet'
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
        local={withLocal}
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
          <h2 className="skl-title">Secrets</h2>
          <span className="skl-subtitle">Keys and passwords your app’s functions use</span>
        </div>
        <div className="skl-tools">
          <button
            type="button"
            className="model-tool-btn"
            onClick={reload}
            disabled={loading}
            aria-label="Refresh"
            title="Refresh"
          >
            <Codicon name="refresh" className={loading && data ? 'icon-spin' : undefined} />
          </button>
          <button
            type="button"
            className="model-tool-btn"
            onClick={() => setDialog({ kind: 'new', published: !withLocal })}
            disabled={!canAdd}
            title={isTeam ? 'Change a team app’s secrets in the Fabric portal' : 'Add a secret'}
          >
            <Codicon name="add" /> New secret
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
              title="Remove local value?"
              message={
                confirm.entry.declared ? (
                  <>
                    Remove the value of {removing} from this computer? Functions that read it fail
                    when your app runs here, until you set it again.
                  </>
                ) : (
                  <>
                    Remove the value of {removing} from this computer? <code>rayfin.yml</code>{' '}
                    doesn’t list it, so your app doesn’t use it.
                  </>
                )
              }
              confirmLabel="Remove"
              danger
              busy={confirmBusy}
              busyLabel="Removing…"
              onConfirm={() => void confirmChange()}
              onCancel={() => (confirmBusy ? undefined : setConfirm(null))}
            />
          ) : (
            <ConfirmModal
              title="Delete secret?"
              message={
                <>
                  Delete {removing} from your published app and from <code>rayfin.yml</code>?
                  Functions that read it stop working until you add it again. You can’t undo this.
                </>
              }
              confirmLabel="Delete"
              danger
              busy={confirmBusy}
              busyLabel="Deleting…"
              onConfirm={() => void confirmChange()}
              onCancel={() => (confirmBusy ? undefined : setConfirm(null))}
            />
          )}
        </Suspense>
      )}
    </div>
  )
}
