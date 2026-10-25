import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react'
import type { SecretEnvironment, SecretInfo, SecretsState, StudioProject } from '@shared/ipc'
import { relativeTime } from './advisor/format'
import { Codicon } from './icons'
import Skeleton from './Skeleton'
import SecretDialog from './secrets/SecretDialog'
import { copilotPrompt, SecretDetails, SecretsOverview, SecretStatus } from './secrets/SecretPanels'
import './skills/skills.css'
import './secrets/secrets.css'

const ConfirmModal = lazy(() => import('./ConfirmModal'))

interface Props {
  project: StudioProject
  /** Called after a secret is added or deleted, so History can refresh. */
  onChanged: () => void
  /** Stage a prompt in the Build chat (used by "Ask Copilot to use it"). */
  onSendToChat?: (display: string, prompt: string) => void
}

const SIGN_IN_HINT =
  'Your Fabric sign-in may have expired: open the account menu and select Refresh Fabric authentication, then try again.'

/** One list of secrets: the app's, or one deployment of a team app. */
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
      : environment.error ?? (environment.secrets.length === 0 ? 'No secrets yet.' : undefined)
  }
}

function SecretRow({
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

/**
 * The Secrets tab: API keys, passwords and connection strings the app's Rayfin
 * functions read as `ctx.Secrets.NAME`. Changes go through the app's Rayfin CLI
 * (`rayfin secret`): values are stored with the deployed app and are write-only,
 * so this tab shows names, descriptions and when values changed. A team app's
 * deployments are listed read-only; their secrets are changed in the portal.
 */
export default function SecretsView({ project, onChanged, onSendToChat }: Props): JSX.Element {
  const [data, setData] = useState<SecretsState | null>(null)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** `<group>:<name>` of the selected secret. */
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  /** null = closed; add = a new secret; set = a value for an existing one. */
  const [dialog, setDialog] = useState<{ kind: 'add' } | { kind: 'set'; secret: SecretInfo } | null>(null)
  const [deleting, setDeleting] = useState<SecretInfo | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const request = useRef(0)

  const load = useCallback(async () => {
    const id = ++request.current
    setLoading(true)
    try {
      const state = await window.api.secrets.list(project.id)
      if (id === request.current) setData(state)
    } catch (err) {
      if (id === request.current) setData({ status: 'error', secrets: [], functionsEnabled: false, error: String(err) })
    } finally {
      if (id === request.current) setLoading(false)
    }
  }, [project.id])

  useEffect(() => {
    setData(null)
    setSelectedKey(null)
  }, [project.id])

  // The list is read when the tab opens. A first deploy (or a switch to another
  // deployment) changes which app the secrets live on, so read it again then.
  const deployedUrl = project.lastDeploy?.url
  useEffect(() => {
    void load()
  }, [load, deployedUrl])

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

  const saved = useCallback(
    (name: string, added: boolean) => {
      setError(null)
      flash(added ? `Added ${name}. Its value is stored with your deployed app.` : `Saved a new value for ${name}.`)
      setSelectedKey(`app:${name}`)
      onChanged()
      void load()
    },
    [flash, load, onChanged]
  )

  const confirmDelete = useCallback(async () => {
    if (!deleting) return
    setDeleteBusy(true)
    setError(null)
    try {
      const result = await window.api.secrets.remove(project.id, deleting.name)
      if (result.ok) {
        flash(`Deleted ${deleting.name}.`)
        setSelectedKey(null)
        onChanged()
        void load()
      } else {
        setError(`${result.error ?? 'Couldn’t delete the secret.'}${result.signIn ? ` ${SIGN_IN_HINT}` : ''}`)
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setDeleteBusy(false)
      setDeleting(null)
    }
  }, [deleting, project.id, flash, onChanged, load])

  const askCopilot = useCallback(
    (secret: SecretInfo) => onSendToChat?.(`Use secret ${secret.name}`, copilotPrompt(secret.name, secret.declared)),
    [onSendToChat]
  )

  // Esc closes the details, unless a dialog is open (it handles Esc itself).
  const dialogOpen = Boolean(dialog || deleting)
  useEffect(() => {
    if (!selectedKey || dialogOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) setSelectedKey(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedKey, dialogOpen])

  const ready = data?.status === 'ready'
  const team = data?.status === 'team'
  const secrets = useMemo(() => (ready ? (data?.secrets ?? []) : []), [ready, data])
  const groups = useMemo<SecretGroup[]>(() => {
    if (team) return (data?.environments ?? []).map(environmentGroup)
    if (ready && secrets.length > 0) {
      return [
        {
          key: 'app',
          title: 'Secrets',
          hint: 'Values are write-only: you can replace them, but nobody can read them back.',
          secrets
        }
      ]
    }
    return []
  }, [team, ready, data, secrets])

  const selection = useMemo(() => {
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

  const section = (group: SecretGroup): JSX.Element => (
    <section className="skl-group" aria-label={group.title} key={group.key}>
      <div className="skl-lane">
        <h3>{group.title}</h3>
        <span className="skl-lane-count">{group.secrets.length}</span>
        <span className="skl-lane-hint">{group.hint}</span>
        {team && group.portalUrl && (
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
              <SecretRow
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

  let content: JSX.Element
  if (!data) {
    content = (
      <div className="skl-loading">
        <Skeleton rows={4} avatar />
      </div>
    )
  } else if (team) {
    content = (
      <>
        <p className="skl-note sec-team-note">
          <Codicon name="info" />
          <span>
            This app is in a team workspace, so Fabricator shows its secrets but can’t change them yet. Change them in
            the Fabric portal: use <strong>Open in Fabric</strong> next to each deployment.
          </span>
        </p>
        {groups.map(section)}
      </>
    )
  } else if (data.status === 'update-rayfin') {
    content = empty(
      'Update Rayfin to use secrets',
      <>
        Secrets need Rayfin 1.36 or newer
        {data.rayfinVersion ? `, and this app uses Rayfin ${data.rayfinVersion}` : ''}. Select Rayfin in the status
        bar and choose <strong>Update with Copilot</strong>.
      </>
    )
  } else if (data.status === 'not-deployed') {
    content = empty(
      'Deploy your app first',
      'Secrets are stored with your deployed app, so you can add them once it’s deployed.'
    )
  } else if (data.status === 'error') {
    content = (
      <div className="skl-empty sec-empty">
        <strong>Couldn’t read this app’s secrets</strong>
        <span>
          {data.error}
          {data.signIn ? ` ${SIGN_IN_HINT}` : ''}
        </span>
        <button type="button" className="btn btn--sm" onClick={() => void load()} disabled={loading}>
          <Codicon name="refresh" /> Try again
        </button>
      </div>
    )
  } else if (secrets.length === 0) {
    content = empty(
      'No secrets yet',
      'Add API keys, passwords and connection strings your functions need. Their values never go into your code.',
      <button type="button" className="btn btn--sm btn--primary" onClick={() => setDialog({ kind: 'add' })}>
        <Codicon name="add" /> New secret
      </button>
    )
  } else {
    content = <>{groups.map(section)}</>
  }

  const facts: [string, string][] = team
    ? (data?.environments ?? []).map((env) => [
        ENVIRONMENT[env.kind]?.title ?? env.kind,
        !env.deployed ? 'Not deployed' : env.error ? '–' : String(env.secrets.filter((s) => s.stored).length)
      ])
    : ready
      ? [['Secrets', String(secrets.length)]]
      : []

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
            onClick={() => void load()}
            disabled={loading}
            aria-label="Refresh"
            title="Refresh"
          >
            <Codicon name="refresh" className={loading && data ? 'icon-spin' : undefined} />
          </button>
          <button
            type="button"
            className="model-tool-btn"
            onClick={() => setDialog({ kind: 'add' })}
            disabled={!ready}
            title={team ? 'Change a team app’s secrets in the Fabric portal' : 'Add a secret'}
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

        {selection ? (
          <SecretDetails
            key={`${selection.group.key}:${selection.secret.name}`}
            secret={selection.secret}
            environment={team ? selection.group.title : undefined}
            canChange={ready}
            busy={loading}
            portalUrl={selection.group.portalUrl}
            onClose={() => setSelectedKey(null)}
            onSetValue={(secret) => setDialog({ kind: 'set', secret })}
            onDelete={setDeleting}
            onAskCopilot={onSendToChat ? askCopilot : undefined}
          />
        ) : data ? (
          <SecretsOverview facts={facts} functionsEnabled={data.functionsEnabled} team={team} />
        ) : null}
      </div>

      {dialog && (
        <SecretDialog
          projectId={project.id}
          replacing={dialog.kind === 'set' ? dialog.secret : null}
          existing={secrets}
          onClose={() => setDialog(null)}
          onSaved={saved}
        />
      )}

      {deleting && (
        <Suspense fallback={null}>
          <ConfirmModal
            title="Delete secret?"
            message={
              <>
                Delete {deleting.name} from your deployed app? Functions that read it stop working until you add it
                again. You can’t undo this.
              </>
            }
            confirmLabel="Delete"
            danger
            busy={deleteBusy}
            busyLabel="Deleting…"
            onConfirm={() => void confirmDelete()}
            onCancel={() => (deleteBusy ? undefined : setDeleting(null))}
          />
        </Suspense>
      )}
    </div>
  )
}
