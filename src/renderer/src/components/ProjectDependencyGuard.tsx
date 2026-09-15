import { useEffect, useState, type ReactNode } from 'react'
import type { StudioProject } from '@shared/ipc'
import { useSuppressPreview } from '../overlay'

interface Props {
  project: StudioProject
  children: ReactNode
  onSwitchProjects: () => void
  hidden: boolean
}

type Readiness =
  | { projectId: string; state: 'checking' }
  | { projectId: string; state: 'ready' }
  | { projectId: string; state: 'error'; error: string }

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Could not prepare this project. Check its dependencies and try again.'
}

/**
 * Blocks project tools until the project's pinned Rayfin CLI is installed.
 * This catches fresh/manual clones before Fabric calls report a missing CLI.
 */
export default function ProjectDependencyGuard({
  project,
  children,
  onSwitchProjects,
  hidden
}: Props): JSX.Element {
  const [attempt, setAttempt] = useState(0)
  const [readiness, setReadiness] = useState<Readiness>({
    projectId: '',
    state: 'checking'
  })
  const ready = readiness.projectId === project.id && readiness.state === 'ready'
  const error =
    readiness.projectId === project.id && readiness.state === 'error' ? readiness.error : null

  // The guard replaces the preview while dependencies install, so hide the native
  // webview that otherwise paints above every DOM element.
  useSuppressPreview(!ready)

  useEffect(() => {
    let cancelled = false
    setReadiness({ projectId: project.id, state: 'checking' })
    void window.api.projects
      .ensureDependencies(project.id)
      .then((result) => {
        if (cancelled) return
        setReadiness(
          result.ok
            ? { projectId: project.id, state: 'ready' }
            : {
                projectId: project.id,
                state: 'error',
                error: result.error ?? "Could not install this project's dependencies."
              }
        )
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setReadiness({ projectId: project.id, state: 'error', error: errorMessage(error) })
        }
      })
    return () => {
      cancelled = true
    }
  }, [project.id, attempt])

  if (ready) return <>{children}</>

  const failed = error !== null
  return (
    <section
      className={`project-dependency-guard${hidden ? ' project-dependency-guard--hidden' : ''}`}
      role={failed ? 'alert' : 'status'}
      aria-label={failed ? `Could not prepare ${project.name}` : `Preparing ${project.name}`}
    >
      <div
        className={`project-dependency-guard-card${
          failed ? ' project-dependency-guard-card--error' : ''
        }`}
      >
        {failed ? (
          <>
            <h2 className="project-dependency-guard-title">
              Couldn't install project dependencies
            </h2>
            <p className="project-dependency-guard-error">{error}</p>
            <div className="project-dependency-guard-actions">
              <button
                className="btn btn--sm btn--primary"
                onClick={() => setAttempt((value) => value + 1)}
              >
                Retry installation
              </button>
              <button className="btn btn--sm btn--ghost" onClick={onSwitchProjects}>
                Switch projects
              </button>
            </div>
          </>
        ) : (
          <>
            <span className="project-dependency-guard-spinner" aria-hidden />
            <h2 className="project-dependency-guard-title">Preparing {project.name}</h2>
            <p className="project-dependency-guard-copy">
              Checking the project's Rayfin CLI and installing missing dependencies...
            </p>
          </>
        )}
      </div>
    </section>
  )
}
