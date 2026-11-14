import { useEffect, useMemo, useState, type CSSProperties, type ReactNode, type JSX } from 'react'
import type {
  TeamDiff,
  TeamDiffFile,
  TeamMap,
  TeamMapApp,
  TeamMapCopy,
  TeamMapRun,
  TeamProblem,
  TeamWorkspace
} from '@shared/ipc'
import { translator, useTranslation } from '../../../i18n'
import ConfirmModal from '../../ConfirmModal'
import { Codicon } from '../../icons'
import { ProblemView, teamError } from '../common'
import TeamDiagnosisModal from '../diagnosis/TeamDiagnosisModal'
import type { DiagnosisInput } from '../diagnosis/useTeamDiagnosis'
import { timeAgo, useNow } from '../runProgress'
import {
  copyHealth,
  deploysPreview,
  previewBehind,
  previewing,
  publishedHealth,
  publishing,
  nodeIds
} from './model'
import {
  Avatar,
  DiffBar,
  FabricGlyph,
  HealthPill,
  StepTimeline,
  changeTitle,
  fabricWorkspaceUrl,
  host,
  hueOf
} from './parts'

interface Props {
  workspace: TeamWorkspace
  map: TeamMap
  runs: TeamMapRun[]
  /** The selected node's id (see `nodeIds`). */
  selection: string
  opening: string | null
  onClose: () => void
  onSelect: (id: string) => void
  onOpenApp: (folder: string) => void
  /** An owner removed the selected app from the workspace. */
  onRemoved: () => void
}

interface Target {
  kind: string
  folder?: string
  branch?: string
}

/** Split a node id: `hub`, `fabric:prod`, `app:<folder>`, `pub:<folder>`, `copy:<folder>:<branch>`. */
export function parseNodeId(id: string): Target {
  if (id === nodeIds.hub || id.startsWith('fabric:')) return { kind: id }
  const [kind, folder, ...rest] = id.split(':')
  return { kind, folder, branch: rest.length ? rest.join(':') : undefined }
}

export interface PatchRow {
  kind: 'hunk' | 'add' | 'del' | 'ctx' | 'note'
  old?: number
  new?: number
  text: string
}

/** Unified-diff hunks as numbered rows. */
export function parsePatch(patch: string): PatchRow[] {
  const rows: PatchRow[] = []
  let oldLine = 0
  let newLine = 0
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      rows.push({ kind: 'hunk', text: line })
    } else if (line.startsWith('+')) {
      rows.push({ kind: 'add', new: newLine++, text: line.slice(1) })
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'del', old: oldLine++, text: line.slice(1) })
    } else if (line.startsWith('\\')) {
      rows.push({ kind: 'note', text: line.slice(1).trim() })
    } else {
      rows.push({ kind: 'ctx', old: oldLine++, new: newLine++, text: line.startsWith(' ') ? line.slice(1) : line })
    }
  }
  return rows
}

const KIND_LETTER: Record<TeamDiffFile['change'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' }

function PatchView({ file }: { file: TeamDiffFile }): JSX.Element {
  const { t } = useTranslation('teamMap')
  const rows = useMemo(() => (file.patch ? parsePatch(file.patch) : []), [file.patch])
  if (!file.patch) {
    return (
      <p className="tmap-patch-note">
        {file.change === 'deleted' ? t('diff.removedFile') : t('diff.noPreview')}
      </p>
    )
  }
  return (
    <div className="tmap-patch">
      {rows.map((row, i) => (
        <div key={i} className={`tmap-patch-line tmap-patch-line--${row.kind}`}>
          <span className="tmap-patch-num">{row.old ?? ''}</span>
          <span className="tmap-patch-num">{row.new ?? ''}</span>
          <code>{row.kind === 'hunk' ? row.text : row.text || ' '}</code>
        </div>
      ))}
      {file.truncated && <div className="tmap-patch-note">{t('diff.fileTruncated')}</div>}
    </div>
  )
}

/** A working copy's changes compared with the published app. */
function DiffView({ workspaceId, app, copy }: { workspaceId: string; app: TeamMapApp; copy: TeamMapCopy }): JSX.Element {
  const { t } = useTranslation('teamMap')
  const local = copy.mine && Boolean(app.projectId)
  const [diff, setDiff] = useState<TeamDiff | null>(null)
  const [openFile, setOpenFile] = useState<string | null>(null)
  const prNumber = copy.pr?.number
  const head = copy.pr?.headSha
  useEffect(() => {
    let alive = true
    setDiff(null)
    setOpenFile(null)
    window.api.team
      .diff(workspaceId, app.folder, local ? undefined : prNumber)
      .then((d) => {
        if (alive) setDiff(d)
      })
      .catch((reason) => {
        if (alive) {
          const error = teamError(reason, translator('teamMap')('diff.loadFailed'))
          setDiff({ ok: false, error, files: [], truncated: false })
        }
      })
    return () => {
      alive = false
    }
  }, [workspaceId, app.folder, copy.branch, prNumber, head, local])

  if (!diff) {
    return (
      <p className="tmap-dim">
        <span className="ws-spinner" /> {t('diff.loading')}
      </p>
    )
  }
  if (!diff.ok) return <div className="alert alert--error">{diff.error ?? t('diff.loadFailed')}</div>
  if (diff.files.length === 0) return <p className="tmap-dim">{t('diff.none')}</p>

  const prefix = `${app.folder}/`
  const additions = diff.files.reduce((sum, f) => sum + f.additions, 0)
  const deletions = diff.files.reduce((sum, f) => sum + f.deletions, 0)
  return (
    <div className="tmap-diff">
      <div className="tmap-diff-summary">
        <span>{t('shared.files', { count: diff.files.length })}</span>
        <DiffBar additions={additions} deletions={deletions} />
        {local && <span className="tmap-chip">{t('diff.unsaved')}</span>}
      </div>
      <ul className="tmap-files">
        {diff.files.map((file) => {
          const name = file.path.startsWith(prefix) ? file.path.slice(prefix.length) : file.path
          const slash = name.lastIndexOf('/')
          const open = openFile === file.path
          return (
            <li key={file.path} className={`tmap-file${open ? ' tmap-file--open' : ''}`}>
              <button
                type="button"
                className="tmap-file-row"
                aria-expanded={open}
                onClick={() => setOpenFile(open ? null : file.path)}
                title={file.path}
              >
                <span className={`tmap-file-kind tmap-file-kind--${file.change}`}>{KIND_LETTER[file.change] ?? 'M'}</span>
                <span className="tmap-file-path">
                  {slash > 0 && <span className="tmap-dim">{name.slice(0, slash + 1)}</span>}
                  {name.slice(slash + 1)}
                </span>
                <span className="tmap-diff-add">+{file.additions}</span>
                <span className="tmap-diff-del">−{file.deletions}</span>
              </button>
              {open && <PatchView file={file} />}
            </li>
          )
        })}
      </ul>
      {diff.truncated && (
        <p className="tmap-dim">
          {t('diff.truncated')}
          {copy.pr && (
            <>
              {' '}
              <button type="button" className="tmap-link" onClick={() => void window.api.openExternal(`${copy.pr?.url}/files`)}>
                {t('diff.seeAll')}
              </button>
            </>
          )}
        </p>
      )}
    </div>
  )
}

function External({ url, children }: { url: string; children: ReactNode }): JSX.Element {
  return (
    <button type="button" className="tmap-link" onClick={() => void window.api.openExternal(url)}>
      {children} <Codicon name="link-external" />
    </button>
  )
}

/** An owner's "Remove from workspace…", with its confirmation. */
function RemoveApp({ workspace, app, onRemoved }: { workspace: TeamWorkspace; app: TeamMapApp; onRemoved: () => void }): JSX.Element {
  const { t } = useTranslation('teamMap')
  const [confirming, setConfirming] = useState(false)
  const [deleteApps, setDeleteApps] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [problem, setProblem] = useState<TeamProblem | null>(null)

  async function remove(): Promise<void> {
    setBusy(true)
    setError(null)
    setProblem(null)
    try {
      const result = await window.api.team.removeProject(workspace.id, app.folder, deleteApps)
      if (!result.ok) {
        if (result.problem) setProblem(result.problem)
        else setError(result.error ?? t('remove.failed'))
        return
      }
      setConfirming(false)
      onRemoved()
    } catch (reason) {
      setError(teamError(reason, t('remove.failed')))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button type="button" className="btn btn--sm btn--ghost" onClick={() => setConfirming(true)}>
        {t('remove.button')}
      </button>
      {confirming && (
        <ConfirmModal
          title={t('remove.title', { name: app.name })}
          danger
          busy={busy}
          confirmLabel={t('actions.remove')}
          message={
            <>
              <p>{t('remove.message')}</p>
              <label className="tmap-check">
                <input type="checkbox" checked={deleteApps} onChange={(event) => setDeleteApps(event.target.checked)} />
                <span>{t('remove.alsoFabric')}</span>
              </label>
              {problem && <ProblemView problem={problem} />}
              {error && <div className="alert alert--error">{error}</div>}
            </>
          }
          onConfirm={() => void remove()}
          onCancel={() => {
            setConfirming(false)
            setDeleteApps(false)
            setError(null)
            setProblem(null)
          }}
        />
      )}
    </>
  )
}

/** Details of whatever is selected in the workspace overview. */
export default function Inspector({
  workspace,
  map,
  runs,
  selection,
  opening,
  onClose,
  onSelect,
  onOpenApp,
  onRemoved
}: Props): JSX.Element {
  const { t } = useTranslation('teamMap')
  const now = useNow(true)
  const [diagnose, setDiagnose] = useState<DiagnosisInput | null>(null)
  const target = parseNodeId(selection)
  const app = target.folder ? map.apps.find((a) => a.folder === target.folder) : undefined
  const copy = app && target.branch ? app.copies.find((c) => c.branch === target.branch) : undefined
  const fabric = workspace.manifest?.fabric
  const viewer = map.viewer?.toLowerCase()
  const owner =
    workspace.role === 'owner' || map.members.some((m) => m.role === 'owner' && m.login.toLowerCase() === viewer)
  let body: JSX.Element

  if (target.kind === 'fabric:prod' || target.kind === 'fabric:preview') {
    const prod = target.kind === 'fabric:prod'
    const ws = prod ? fabric?.production : fabric?.previews
    body = (
      <>
        <header className="tmap-insp-head">
          <FabricGlyph />
          <div className="tmap-titles">
            <span className="tmap-kicker">{t('fabric.kicker')}</span>
            <h3>{prod ? t('shared.publishedApps') : t('shared.previews')}</h3>
            <span className="tmap-dim">{ws?.name}</span>
          </div>
        </header>
        <p className="tmap-insp-text">
          {prod ? t('fabric.prodText') : t('fabric.previewText')}
        </p>
        <section className="tmap-insp-section">
          <h4>{prod ? t('shared.apps') : t('shared.previews')}</h4>
          <ul className="tmap-insp-list">
            {map.apps.flatMap((a) =>
              prod
                ? a.published
                  ? [
                      <li key={a.folder}>
                        <button type="button" className="tmap-insp-row tmap-insp-row--button" onClick={() => onSelect(nodeIds.published(a.folder))}>
                          <span className="tmap-mark tmap-mark--sm" style={{ '--hue': hueOf(a.folder) } as CSSProperties}>
                            {(a.name.trim()[0] ?? '?').toUpperCase()}
                          </span>
                          <span className="tmap-insp-grow">{a.name}</span>
                          <HealthPill health={publishedHealth(a, runs)} />
                        </button>
                      </li>
                    ]
                  : []
                : a.copies.map((c) => (
                    <li key={`${a.folder}:${c.branch}`}>
                      <button type="button" className="tmap-insp-row tmap-insp-row--button" onClick={() => onSelect(nodeIds.copy(a.folder, c.branch))}>
                        <Avatar login={c.author || 'you'} url={c.avatarUrl} size={22} />
                        <span className="tmap-insp-grow">
                          {a.name}
                          <span className="tmap-dim"> · {c.mine ? t('fabric.you') : c.author}</span>
                        </span>
                        <HealthPill health={copyHealth(a, c, runs)} />
                      </button>
                    </li>
                  ))
            )}
          </ul>
        </section>
        {ws?.id && (
          <div className="tmap-insp-actions">
            <button type="button" className="btn btn--sm" onClick={() => void window.api.openExternal(fabricWorkspaceUrl(ws.id))}>
              {t('shared.openInFabric')} <Codicon name="link-external" />
            </button>
          </div>
        )}
      </>
    )
  } else if (!app) {
    body = <p className="tmap-dim">{t('shared.gone')}</p>
  } else if (target.kind === 'app') {
    body = (
      <>
        <header className="tmap-insp-head">
          <span className="tmap-mark" style={{ '--hue': hueOf(app.folder) } as CSSProperties}>
            {(app.name.trim()[0] ?? '?').toUpperCase()}
          </span>
          <div className="tmap-titles">
            <span className="tmap-kicker">{t('app.kicker')}</span>
            <h3>{app.name}</h3>
            <span className="tmap-mono tmap-dim">{app.folder}/</span>
          </div>
        </header>
        <section className="tmap-insp-section">
          <h4>{t('shared.published')}</h4>
          {app.published ? (
            <div className="tmap-insp-row">
              <HealthPill health={publishedHealth(app, runs)} />
              <span className="tmap-insp-grow tmap-dim">
                {app.production?.updatedAt
                  ? t('shared.updated', { time: timeAgo(app.production.updatedAt, now) })
                  : t('shared.notDeployed')}
              </span>
              {app.production?.url && <External url={app.production.url}>{t('shared.visit')}</External>}
            </div>
          ) : (
            <p className="tmap-insp-text">{t('app.notPublished')}</p>
          )}
        </section>
        <section className="tmap-insp-section">
          <h4>{t('app.workingCopies')}</h4>
          <ul className="tmap-insp-list">
            {app.copies.map((c) => (
              <li key={c.branch}>
                <button type="button" className="tmap-insp-row tmap-insp-row--button" onClick={() => onSelect(nodeIds.copy(app.folder, c.branch))}>
                  <Avatar login={c.author || 'you'} url={c.avatarUrl} size={22} />
                  <span className="tmap-insp-grow">
                    {c.mine ? t('shared.you') : c.author}
                    <span className="tmap-dim tmap-block">{changeTitle(c.pr?.title, app.name) ?? t('shared.notOnGitHub')}</span>
                  </span>
                  <DiffBar additions={c.additions} deletions={c.deletions} />
                </button>
              </li>
            ))}
            {app.copies.length === 0 && <li className="tmap-dim">{t('app.nobody')}</li>}
          </ul>
        </section>
        <div className="tmap-insp-actions">
          <button type="button" className="btn btn--sm btn--primary" disabled={opening !== null} onClick={() => onOpenApp(app.folder)}>
            {opening === app.folder ? t('shared.opening') : app.projectId ? t('actions.open') : t('app.openHere')}
          </button>
          {owner && <RemoveApp key={app.folder} workspace={workspace} app={app} onRemoved={onRemoved} />}
        </div>
      </>
    )
  } else if (target.kind === 'pub') {
    const deploying = publishing(app, runs)
    const record = app.production
    body = (
      <>
        <header className="tmap-insp-head">
          <span className="tmap-icon-tile">
            <Codicon name="globe" />
          </span>
          <div className="tmap-titles">
            <span className="tmap-kicker">{t('pub.kicker')}</span>
            <h3>{app.name}</h3>
            <HealthPill health={publishedHealth(app, runs)} />
          </div>
        </header>
        {deploying ? (
          <section className="tmap-insp-section">
            <h4>{t('pub.publishingNow')}</h4>
            {deploying.job ? (
              <StepTimeline steps={deploying.job.steps} now={now} />
            ) : (
              <p className="tmap-dim">{t('pub.gettingReady')}</p>
            )}
            <External url={deploying.job?.url ?? deploying.run.url}>{t('shared.watchOnGitHub')}</External>
          </section>
        ) : (
          <section className="tmap-insp-section">
            <h4>{t('pub.latest')}</h4>
            {record ? (
              <ul className="tmap-facts">
                {record.url && (
                  <li>
                    <span>{t('pub.address')}</span>
                    <External url={record.url}>{host(record.url)}</External>
                  </li>
                )}
                {record.sha && (
                  <li>
                    <span>{t('pub.version')}</span>
                    <span className="tmap-mono">{record.sha.slice(0, 7)}</span>
                  </li>
                )}
                {record.updatedAt && (
                  <li>
                    <span>{t('pub.when')}</span>
                    <span>{timeAgo(record.updatedAt, now)}</span>
                  </li>
                )}
                {record.logUrl && (
                  <li>
                    <span>{t('pub.log')}</span>
                    <External url={record.logUrl}>{t('runLabel.pipelineRun')}</External>
                  </li>
                )}
              </ul>
            ) : (
              <p className="tmap-dim">{t('pub.notDeployed')}</p>
            )}
            {record?.reason === 'data-loss' && (
              <p className="tmap-insp-warn">{t('pub.dataLoss')}</p>
            )}
          </section>
        )}
        <div className="tmap-insp-actions">
          {record?.url && (
            <button type="button" className="btn btn--sm btn--primary" onClick={() => void window.api.openExternal(record.url ?? '')}>
              {t('shared.visit')} <Codicon name="link-external" />
            </button>
          )}
          {record?.portalUrl && (
            <button type="button" className="btn btn--sm" onClick={() => void window.api.openExternal(record.portalUrl ?? '')}>
              {t('shared.openInFabric')} <Codicon name="link-external" />
            </button>
          )}
          {!deploying && publishedHealth(app, runs) === 'failed' && (
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => setDiagnose({ kind: 'pipeline', workspaceId: workspace.id, runUrl: record?.logUrl, projectId: app.projectId })}
            >
              <Codicon name="sparkle" /> {t('shared.diagnose')}
            </button>
          )}
        </div>
      </>
    )
  } else if (copy) {
    const deploying = previewing(app, copy, runs)
    const health = copyHealth(app, copy, runs)
    const title = changeTitle(copy.pr?.title, app.name)
    body = (
      <>
        <header className="tmap-insp-head">
          <Avatar login={copy.author || 'you'} url={copy.avatarUrl} size={40} />
          <div className="tmap-titles">
            <span className="tmap-kicker">{copy.mine ? t('copy.mine') : t('copy.theirs', { author: copy.author })}</span>
            <h3>{title ?? app.name}</h3>
            <span className="tmap-mono tmap-dim tmap-ellipsis" title={copy.branch}>
              {copy.branch}
            </span>
          </div>
        </header>
        <div className="tmap-chips">
          {copy.pr ? (
            <span className="tmap-chip">
              #{copy.pr.number} · {copy.pr.draft ? t('copy.draft') : t('copy.ready')}
            </span>
          ) : (
            <span className="tmap-chip">{t('shared.notOnGitHub')}</span>
          )}
          <span className="tmap-chip">{t('copy.saves', { count: copy.commits })}</span>
          {copy.localEdits && <span className="tmap-chip tmap-chip--warn">{t('copy.unsaved')}</span>}
          {(copy.behind ?? 0) > 0 && <span className="tmap-chip">{t('copy.behind', { count: copy.behind ?? 0 })}</span>}
          {copy.review === 'APPROVED' && <span className="tmap-chip tmap-chip--ok">{t('copy.approved')}</span>}
          {copy.review === 'CHANGES_REQUESTED' && <span className="tmap-chip tmap-chip--danger">{t('copy.changesRequested')}</span>}
        </div>
        <section className="tmap-insp-section">
          <h4>{t('shared.preview')}</h4>
          <div className="tmap-insp-row">
            <HealthPill health={health} />
            <span className="tmap-insp-grow tmap-dim">
              {deploying
                ? t('copy.deploying')
                : previewBehind(copy)
                  ? t('copy.earlier')
                  : copy.preview?.updatedAt
                    ? t('shared.updated', { time: timeAgo(copy.preview.updatedAt, now) })
                    : copy.preview
                      ? ''
                      : !deploysPreview(workspace, copy)
                        ? copy.mine
                          ? t('copy.localMine')
                          : t('copy.localTheirs', { author: copy.author })
                        : t('shared.notDeployed')}
            </span>
            {copy.preview?.url && !deploying && <External url={copy.preview.url}>{t('actions.open')}</External>}
          </div>
          {deploying?.job && <StepTimeline steps={deploying.job.steps} now={now} />}
          {deploying && <External url={deploying.job?.url ?? deploying.run.url}>{t('shared.watchOnGitHub')}</External>}
          {!deploying && health === 'failed' && copy.preview?.logUrl && (
            <External url={copy.preview.logUrl}>{t('copy.seeWhy')}</External>
          )}
          {!deploying && health === 'failed' && (
            <button
              type="button"
              className="tmap-link"
              onClick={() =>
                setDiagnose({
                  kind: 'pipeline',
                  workspaceId: workspace.id,
                  runUrl: copy.preview?.logUrl,
                  projectId: copy.mine ? app.projectId : undefined
                })
              }
            >
              <Codicon name="sparkle" /> {t('shared.diagnose')}
            </button>
          )}
        </section>
        <section className="tmap-insp-section">
          <h4>{t('copy.changes')}</h4>
          <DiffView workspaceId={workspace.id} app={app} copy={copy} />
        </section>
        <div className="tmap-insp-actions">
          {copy.mine && (
            <button type="button" className="btn btn--sm btn--primary" disabled={opening !== null} onClick={() => onOpenApp(app.folder)}>
              {opening === app.folder ? t('shared.opening') : t('copy.continue')}
            </button>
          )}
          {copy.pr && (
            <button type="button" className="btn btn--sm" onClick={() => void window.api.openExternal(copy.pr?.url ?? '')}>
              {t('copy.viewOnGitHub')} <Codicon name="link-external" />
            </button>
          )}
        </div>
      </>
    )
  } else {
    body = <p className="tmap-dim">{t('copy.gone')}</p>
  }

  return (
    <aside className="tmap-side tmap-inspector" aria-label={t('actions.details')}>
      <button
        type="button"
        className="tmap-icon-btn tmap-inspector-close"
        onClick={onClose}
        aria-label={t('inspector.closeDetails')}
        title={t('shared.backToDeployments')}
      >
        <Codicon name="close" />
      </button>
      {body}
      {diagnose && <TeamDiagnosisModal input={diagnose} title={t('inspector.diagnoseDeploy')} onClose={() => setDiagnose(null)} />}
    </aside>
  )
}
