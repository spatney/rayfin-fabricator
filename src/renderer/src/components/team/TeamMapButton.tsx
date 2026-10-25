import type { TeamMapRun } from '@shared/ipc'
import { activeDeploys } from './useTeamActivity'
import './team.css'

import type { JSX } from 'react'

interface Props {
  /** The workspace pipeline's recent runs. */
  runs: TeamMapRun[]
  onClick: () => void
}

/**
 * The workspace overview, as the last segment of the team app's control in the
 * app bar (as Share ends the deploy control), with a dot while anything deploys.
 */
export default function TeamMapButton({ runs, onClick }: Props): JSX.Element {
  const active = activeDeploys(runs).length
  const label = active
    ? `Workspace overview: ${active} deployment${active === 1 ? '' : 's'} in progress`
    : 'Workspace overview: every app, change and deployment in this team workspace'
  return (
    <button
      type="button"
      className="seg-btn team-map-btn"
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      <span className="team-map-btn-ico" aria-hidden="true">
        <span className="codicon codicon-type-hierarchy-sub" />
        {active > 0 && <span className="team-map-btn-dot" />}
      </span>
      <span className="team-map-btn-label" aria-hidden="true">
        Overview
      </span>
    </button>
  )
}
