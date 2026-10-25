import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type {
  MigrationCheck,
  MigrationInspectedPage,
  MigrationReportItem,
  MigrationSource,
  MigrationWorkspace,
  MigrationWorkspacesResult,
  ReportInspection
} from '@shared/ipc'
import { useSuppressPreview } from '../../overlay'
import { authErrorMessage } from '../../authErrors'
import { openDocs } from '../../docsLinks'
import { Codicon } from '../icons'
import './migrate.css'

/** A report picked for migration: what the new app is built from. */
export interface ReportPick {
  source: MigrationSource
  pages: MigrationInspectedPage[]
}

interface Props {
  /** Workspaces your apps use, most recent first (ids or names): listed first. */
  recentWorkspaces?: readonly string[]
  onCancel: () => void
  onPicked: (pick: ReportPick) => void
}

type Load<T> = { status: 'idle' } | { status: 'loading' } | { status: 'error'; error: string; needsAz?: boolean } | { status: 'ready'; value: T }

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/** A pasted report link or id, rather than words to search for. */
export function isReportLink(text: string): boolean {
  const t = text.trim()
  return /^https?:\/\//i.test(t) || (GUID.test(t) && t.replace(GUID, '').trim() === '')
}

/** The report a successful inspection describes, ready to migrate. */
export function pickFromInspection(inspection: ReportInspection): ReportPick | null {
  const report = inspection.report
  if (!inspection.ok || !report || inspection.blocked) return null
  const model = inspection.model
  return {
    source: {
      reportId: report.id,
      reportName: report.name,
      workspaceId: report.workspaceId,
      workspaceName: report.workspaceName ?? (report.personal ? 'My workspace' : undefined),
      personal: report.personal,
      webUrl: report.webUrl,
      format: report.format,
      modelId: model?.id,
      modelName: model?.name,
      modelWorkspaceId: model?.workspaceId,
      modelWorkspaceName: model?.workspaceName
    },
    pages: inspection.pages
  }
}

/** "Sales · Finance · 4 pages · data from “Sales model”": the picked report, for the New project screen. */
export function describePick(pick: ReportPick): string {
  const { source, pages } = pick
  return [
    source.reportName,
    source.workspaceName ?? (source.personal ? 'My workspace' : undefined),
    pages.length ? `${pages.length} page${pages.length === 1 ? '' : 's'}` : undefined,
    source.modelName ? `data from “${source.modelName}”` : undefined
  ]
    .filter(Boolean)
    .join(' · ')
}

/** The workspaces with the ones your apps use first, then as listed. */
function ordered(workspaces: readonly MigrationWorkspace[], recent: readonly string[]): MigrationWorkspace[] {
  const keys = recent.map((r) => r.toLowerCase())
  const rank = (w: MigrationWorkspace): number => {
    const at = keys.findIndex((k) => k === w.id.toLowerCase() || k === w.name.toLowerCase())
    return at < 0 ? keys.length : at
  }
  return [...workspaces].sort((a, b) => rank(a) - rank(b))
}

const failure = (result: { error?: string; needsAz?: boolean }, fallback: string) =>
  ({ status: 'error', error: result.error || fallback, needsAz: result.needsAz }) as const

/**
 * Migrate a Power BI report: pick one (search, browse your workspaces, or paste
 * a link), see what Fabricator can read of it, and continue to name the new app.
 * Everything is read with the Azure CLI's sign-in.
 */
export default function MigrateReportScreen({ recentWorkspaces = [], onCancel, onPicked }: Props): JSX.Element {
  useSuppressPreview()
  const [workspaces, setWorkspaces] = useState<Load<MigrationWorkspacesResult>>({ status: 'loading' })
  const [selectedWs, setSelectedWs] = useState<string | null>(null)
  const [reports, setReports] = useState<Record<string, Load<MigrationReportItem[]>>>({})
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Load<MigrationReportItem[]>>({ status: 'idle' })
  const [chosen, setChosen] = useState<string | null>(null)
  const [inspection, setInspection] = useState<Load<ReportInspection>>({ status: 'idle' })
  const [reload, setReload] = useState(0)
  const inspectSeq = useRef(0)

  useEffect(() => {
    let alive = true
    setWorkspaces({ status: 'loading' })
    setReports({})
    window.api.migration.workspaces().then(
      (result) => {
        if (!alive) return
        if (!result.ok) return setWorkspaces(failure(result, 'Could not list your workspaces.'))
        setWorkspaces({ status: 'ready', value: result })
        setSelectedWs((current) => current ?? ordered(result.workspaces, recentWorkspaces)[0]?.id ?? null)
      },
      (reason) => alive && setWorkspaces({ status: 'error', error: authErrorMessage(reason, 'Could not list your workspaces.') })
    )
    return () => {
      alive = false
    }
  }, [reload])

  // The reports in the chosen workspace, once per workspace.
  useEffect(() => {
    if (!selectedWs || reports[selectedWs]) return
    const ws = selectedWs
    setReports((all) => ({ ...all, [ws]: { status: 'loading' } }))
    window.api.migration.reports(ws).then(
      (result) =>
        setReports((all) => ({
          ...all,
          [ws]: result.ok ? { status: 'ready', value: result.reports } : failure(result, 'Could not list the reports.')
        })),
      (reason) =>
        setReports((all) => ({ ...all, [ws]: { status: 'error', error: authErrorMessage(reason, 'Could not list the reports.') } }))
    )
  }, [selectedWs, reports])

  const trimmed = query.trim()
  const pasted = isReportLink(trimmed)
  const searching = !pasted && trimmed.length >= 2

  // Search the catalog shortly after typing stops.
  useEffect(() => {
    if (!searching) {
      setResults({ status: 'idle' })
      return
    }
    let stale = false
    setResults({ status: 'loading' })
    const timer = window.setTimeout(() => {
      window.api.migration.search(trimmed).then(
        (result) => {
          if (stale) return
          setResults(result.ok ? { status: 'ready', value: result.reports } : failure(result, 'Could not search for reports.'))
        },
        (reason) => !stale && setResults({ status: 'error', error: authErrorMessage(reason, 'Could not search for reports.') })
      )
    }, 350)
    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [trimmed, searching])

  function inspect(request: { target?: string; workspaceId?: string; reportId?: string }, key: string): void {
    const seq = ++inspectSeq.current
    setChosen(key)
    setInspection({ status: 'loading' })
    window.api.migration.inspect(request).then(
      (result) => {
        if (seq !== inspectSeq.current) return
        setInspection(result.ok ? { status: 'ready', value: result } : failure(result, 'Could not read the report.'))
      },
      (reason) => seq === inspectSeq.current && setInspection({ status: 'error', error: authErrorMessage(reason, 'Could not read the report.') })
    )
  }

  // Esc leaves the screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const list = workspaces.status === 'ready' ? ordered(workspaces.value.workspaces, recentWorkspaces) : []
  const account = workspaces.status === 'ready' ? workspaces.value.account : undefined
  const shown: Load<MigrationReportItem[]> = searching ? results : selectedWs ? (reports[selectedWs] ?? { status: 'loading' }) : { status: 'idle' }
  const pick = useMemo(() => (inspection.status === 'ready' ? pickFromInspection(inspection.value) : null), [inspection])

  return (
    <div className="create-screen mig-screen">
      <div className="create-shell mig-shell">
        <header className="create-head">
          <div className="create-head-text">
            <h1 className="create-title">Migrate a Power BI report</h1>
            <p className="create-sub">
              Pick a report. Fabricator turns it into a new app that reads the report&rsquo;s data live, and Copilot rebuilds
              its pages one at a time.{' '}
              <button type="button" className="link-btn" onClick={() => openDocs('migrate')}>
                Learn more
              </button>
            </p>
          </div>
        </header>

        <div className="create-body mig-body">
          <label className="field">
            <span className="field-label">Find a report</span>
            <input
              className="field-input"
              type="search"
              value={query}
              autoFocus
              placeholder="Search by name, or paste a report link"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && pasted) inspect({ target: trimmed }, `link:${trimmed}`)
              }}
            />
            <span className="field-hint">
              {pasted && chosen !== `link:${trimmed}` ? (
                <>
                  Press Enter to read this report, or{' '}
                  <button type="button" className="link-btn" onClick={() => inspect({ target: trimmed }, `link:${trimmed}`)}>
                    read it now
                  </button>
                  .
                </>
              ) : account?.user ? (
                `Reports you can open as ${account.user}, through the Azure CLI.`
              ) : (
                'Reports you can open, through the Azure CLI.'
              )}
            </span>
          </label>

          {workspaces.status === 'error' ? (
            <LoadError error={workspaces.error} needsAz={workspaces.needsAz} onRetry={() => setReload((n) => n + 1)} />
          ) : (
            <div className="mig-panes">
              {!searching && (
                <nav className="mig-pane mig-ws" aria-label="Workspaces">
                  {workspaces.status === 'loading' ? (
                    <p className="mig-state">Loading workspaces…</p>
                  ) : (
                    <ul>
                      {list.map((w) => (
                        <li key={w.id}>
                          <button
                            type="button"
                            className={`mig-ws-item${w.id === selectedWs ? ' mig-ws-item--sel' : ''}`}
                            aria-current={w.id === selectedWs ? 'true' : undefined}
                            onClick={() => setSelectedWs(w.id)}
                          >
                            <Codicon name={w.personal ? 'account' : 'folder'} />
                            <span className="mig-ws-name">{w.name}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </nav>
              )}
              <section className="mig-pane mig-reports" aria-label={searching ? 'Search results' : 'Reports'}>
                <ReportList
                  load={shown}
                  chosen={chosen}
                  showWorkspace={searching}
                  empty={searching ? 'No reports match.' : 'This workspace has no reports.'}
                  onChoose={(r) => inspect({ workspaceId: r.workspaceId, reportId: r.id }, r.id)}
                />
              </section>
            </div>
          )}

          <Inspection load={inspection} />
        </div>

        <footer className="create-foot mig-foot-bar">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={!pick} onClick={() => pick && onPicked(pick)}>
            Continue
          </button>
        </footer>
      </div>
    </div>
  )
}

function LoadError({ error, needsAz, onRetry }: { error: string; needsAz?: boolean; onRetry: () => void }): JSX.Element {
  return (
    <div className="mig-error" role="alert">
      <p>{needsAz ? 'Sign in to the Azure CLI again (run az login), then try again.' : error}</p>
      <button type="button" className="btn btn--sm" onClick={onRetry}>
        Try again
      </button>
    </div>
  )
}

function ReportList({
  load,
  chosen,
  showWorkspace,
  empty,
  onChoose
}: {
  load: Load<MigrationReportItem[]>
  chosen: string | null
  showWorkspace: boolean
  empty: string
  onChoose: (report: MigrationReportItem) => void
}): JSX.Element | null {
  if (load.status === 'idle') return null
  if (load.status === 'loading') return <p className="mig-state">Loading reports…</p>
  if (load.status === 'error') {
    return <p className="mig-state mig-state--bad">{load.needsAz ? 'Sign in to the Azure CLI again (run az login).' : load.error}</p>
  }
  if (load.value.length === 0) return <p className="mig-state">{empty}</p>
  return (
    <ul>
      {load.value.map((r) => (
        <li key={`${r.workspaceId}:${r.id}`}>
          <button
            type="button"
            className={`mig-report${chosen === r.id ? ' mig-report--sel' : ''}`}
            aria-pressed={chosen === r.id}
            onClick={() => onChoose(r)}
          >
            <Codicon name="graph" />
            <span className="mig-report-name">{r.name}</span>
            {showWorkspace && r.workspaceName && <span className="mig-report-ws">{r.workspaceName}</span>}
          </button>
        </li>
      ))}
    </ul>
  )
}

const CHECKS: ReadonlyArray<['definition' | 'model' | 'images', string]> = [
  ['definition', 'Definition'],
  ['model', 'Data model'],
  ['images', 'Page images']
]

function Inspection({ load }: { load: Load<ReportInspection> }): JSX.Element | null {
  if (load.status === 'idle') return null
  if (load.status === 'loading') {
    return (
      <section className="mig-inspect" aria-busy="true">
        <p className="mig-state">Reading the report…</p>
      </section>
    )
  }
  if (load.status === 'error') {
    return (
      <section className="mig-inspect">
        <p className="mig-state mig-state--bad" role="alert">
          {load.needsAz ? 'Sign in to the Azure CLI again (run az login), then pick the report again.' : load.error}
        </p>
      </section>
    )
  }
  const { report, model, pages, checks, blocked } = load.value
  if (!report) return null
  const names = pages.map((p) => p.displayName)
  // A check that already gives the reason isn't repeated below the checks.
  const blockedNote = blocked && !CHECKS.some(([key]) => checks?.[key].message === blocked) ? blocked : null
  return (
    <section className="mig-inspect" aria-label={`About ${report.name}`}>
      <h2 className="mig-inspect-title">{report.name}</h2>
      <p className="mig-inspect-meta">
        {report.workspaceName ?? (report.personal ? 'My workspace' : 'Workspace')}
        {model?.name && <> · data from “{model.name}”</>}
        {pages.length > 0 && (
          <>
            {' '}
            · {pages.length} page{pages.length === 1 ? '' : 's'}: {names.slice(0, 6).join(', ')}
            {names.length > 6 && `, and ${names.length - 6} more`}
          </>
        )}
      </p>
      {checks && (
        <ul className="mig-checks">
          {CHECKS.map(([key, label]) => (
            <CheckRow key={key} label={label} check={checks[key]} />
          ))}
        </ul>
      )}
      {blockedNote && (
        <p className="mig-blocked" role="alert">
          {blockedNote}
        </p>
      )}
    </section>
  )
}

function CheckRow({ label, check }: { label: string; check: MigrationCheck }): JSX.Element {
  return (
    <li className={`mig-check mig-check--${check.status}`}>
      <span className="mig-dot" aria-hidden="true" />
      <span className="mig-check-label">{label}</span>
      <span className="mig-check-msg">{check.message}</span>
    </li>
  )
}
