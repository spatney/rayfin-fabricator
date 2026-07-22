import { useEffect, useId, useState } from 'react'
import type { FabricReport, FabricWorkspacesResult } from '@shared/ipc'
import { useSuppressPreview } from '../overlay'
import { useModalFocus } from '../modalFocus'
import { Codicon } from './icons'

interface Props {
  onClose: () => void
  /**
   * The user picked a workspace + report to migrate. The parent closes this
   * picker and hands the selection to the standard create flow (which scaffolds
   * the data-app project, installs deps, fetches the report code, then deploys).
   */
  onSelect: (workspaceId: string, report: FabricReport) => void
}

/**
 * The "Migrate a Power BI report" picker: pick a Fabric workspace, then a report
 * inside it. Both lists are loaded live from Fabric — workspaces via
 * `fabric.listWorkspaces`, and the report list via `fabric.listReports`
 * whenever the chosen workspace changes. Confirming hands the selection to
 * `onSelect`; the actual create + fetch + deploy runs in the shared create flow.
 */
export default function MigratePowerBIReportModal({ onClose, onSelect }: Props): JSX.Element {
  useSuppressPreview()
  const titleId = useId()
  const dialogRef = useModalFocus<HTMLDivElement>()

  const [wsResult, setWsResult] = useState<FabricWorkspacesResult | null>(null)
  const [loadingWs, setLoadingWs] = useState(false)
  const [workspaceId, setWorkspaceId] = useState('')

  const [reports, setReports] = useState<FabricReport[]>([])
  const [loadingReports, setLoadingReports] = useState(false)
  const [reportsError, setReportsError] = useState<string | null>(null)
  const [reportsNeedLogin, setReportsNeedLogin] = useState(false)
  const [reportsRefresh, setReportsRefresh] = useState(0)
  const [reportId, setReportId] = useState('')

  const [signingIn, setSigningIn] = useState(false)
  const [signInError, setSignInError] = useState<string | null>(null)

  async function loadWorkspaces(): Promise<void> {
    setLoadingWs(true)
    try {
      const res = await window.api.fabric.listWorkspaces()
      setWsResult(res)
    } finally {
      setLoadingWs(false)
    }
  }

  // Open the interactive Fabric sign-in window, then reload the lists. This is
  // how a report-migrator authenticates from the Home screen (where no project
  // is active); the write scope itself is only requested later, at migrate time.
  async function signIn(): Promise<void> {
    setSigningIn(true)
    setSignInError(null)
    try {
      const res = await window.api.fabric.signIn()
      if (!res.ok) {
        setSignInError(res.error ?? 'Fabric sign-in failed.')
        return
      }
      await loadWorkspaces()
      if (workspaceId) setReportsRefresh((n) => n + 1)
    } finally {
      setSigningIn(false)
    }
  }

  useEffect(() => {
    void loadWorkspaces()
  }, [])

  // Load the reports for the chosen workspace. Re-runs on every workspace change
  // and guards against a slow earlier request overwriting a newer selection.
  useEffect(() => {
    if (!workspaceId) {
      setReports([])
      setReportsError(null)
      setReportsNeedLogin(false)
      return
    }
    let cancelled = false
    setLoadingReports(true)
    setReportsError(null)
    setReportsNeedLogin(false)
    setReports([])
    void window.api.fabric
      .listReports(workspaceId)
      .then((res) => {
        if (cancelled) return
        if (res.ok) {
          setReports(res.reports ?? [])
        } else {
          setReportsNeedLogin(Boolean(res.needsLogin))
          setReportsError(res.error ?? 'Could not load reports for this workspace.')
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingReports(false)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, reportsRefresh])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const workspaces = wsResult?.ok && wsResult.workspaces ? wsResult.workspaces : []
  const canMigrate = Boolean(workspaceId && reportId)

  // Shared "you need a Fabric session" prompt + sign-in button, reused by both
  // the workspace and report lists when they come back needing a login.
  const signInPrompt = (message: string): JSX.Element => (
    <div className="ws-signin">
      <p className="ws-empty-sub">{message}</p>
      <button
        type="button"
        className="btn btn--sm btn--primary"
        disabled={signingIn}
        onClick={() => void signIn()}
      >
        {signingIn ? 'Signing in…' : 'Sign in to Microsoft Fabric'}
      </button>
      {signInError && <p className="ws-empty-sub">{signInError}</p>}
    </div>
  )

  async function migrate(): Promise<void> {
    const report = reports.find((r) => r.id === reportId)
    if (!report) return
    onSelect(workspaceId, report)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal modal--sm"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={titleId}>Migrate Power BI report</h2>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            aria-label="Close Power BI migration"
            onClick={onClose}
          >
            <span className="codicon codicon-close" aria-hidden="true" />
          </button>
        </div>

        <div className="modal-body">
          <div className="dep-field">
            <div className="dep-field-head">
              <span className="dep-field-label">Workspace</span>
              <button
                className="ws-refresh"
                type="button"
                title="Refresh workspaces"
                aria-label="Refresh workspaces"
                disabled={loadingWs}
                onClick={() => void loadWorkspaces()}
              >
                <Codicon name="refresh" />
              </button>
            </div>
            {loadingWs ? (
              <div className="ws-loading">
                <span className="ws-spinner" />
                Loading your workspaces…
              </div>
            ) : workspaces.length > 0 ? (
              <select
                className="ws-input"
                aria-label="Workspace"
                value={workspaceId}
                onChange={(event) => {
                  setWorkspaceId(event.target.value)
                  setReportId('')
                }}
              >
                <option value="">Select a workspace…</option>
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.displayName}
                  </option>
                ))}
              </select>
            ) : wsResult?.needsLogin ? (
              signInPrompt('Sign in to Microsoft Fabric to list your workspaces.')
            ) : (
              <p className="ws-empty-sub">
                Couldn’t load workspaces{wsResult?.error ? `: ${wsResult.error}` : '.'}
              </p>
            )}
          </div>

          <div className="dep-field">
            <div className="dep-field-head">
              <span className="dep-field-label">Report</span>
              {workspaceId && (
                <button
                  className="ws-refresh"
                  type="button"
                  title="Refresh reports"
                  aria-label="Refresh reports"
                  disabled={loadingReports}
                  onClick={() => setReportsRefresh((n) => n + 1)}
                >
                  <Codicon name="refresh" />
                </button>
              )}
            </div>
            {loadingReports ? (
              <div className="ws-loading">
                <span className="ws-spinner" />
                Loading reports…
              </div>
            ) : reportsError ? (
              reportsNeedLogin ? (
                signInPrompt('Sign in to Microsoft Fabric to list this workspace’s reports.')
              ) : (
                <p className="ws-empty-sub">{`Couldn’t load reports: ${reportsError}`}</p>
              )
            ) : (
              <>
                <select
                  className="ws-input"
                  aria-label="Report"
                  value={reportId}
                  disabled={!workspaceId || reports.length === 0}
                  onChange={(event) => setReportId(event.target.value)}
                >
                  <option value="">
                    {!workspaceId
                      ? 'Select a workspace first…'
                      : reports.length === 0
                        ? 'No Power BI reports in this workspace'
                        : 'Select a report…'}
                  </option>
                  {reports.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.displayName}
                    </option>
                  ))}
                </select>
                {workspaceId && reports.length === 0 && (
                  <p className="ws-empty-sub">This workspace has no Power BI reports to migrate.</p>
                )}
              </>
            )}
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!canMigrate}
            onClick={() => void migrate()}
          >
            Migrate report
          </button>
        </div>
      </div>
    </div>
  )
}
