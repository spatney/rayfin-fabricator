import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  DeleteProgressEvent,
  FabricDeleteResult,
  ProjectsState,
  StudioProject
} from '@shared/ipc'
import { authErrorMessage } from './authErrors'

/**
 * A project being removed in the background, or one whose removal stopped. The
 * folder always moves to the system trash; the published app is deleted first
 * when chosen. Removals run side by side, so the app stays usable meanwhile.
 */
export interface ProjectRemoval {
  project: StudioProject
  /** The published Fabric app is deleted too. */
  deleteApp: boolean
  /** The app is gone already, so a retry only trashes the folder. */
  appDeleted: boolean
  /** The step running, or the one that failed. */
  step: 'app' | 'signin' | 'folder'
  /** Why the removal stopped. The project stays until it's tried again. */
  error?: string
  /** The folder's live file count while it moves to trash. */
  progress?: DeleteProgressEvent
  /** When the move to trash itself began (the OS reports no progress for it). */
  trashingSince?: number
}

export interface ProjectRemovals {
  /** Removals running or stopped, by project id. */
  removals: Readonly<Record<string, ProjectRemoval>>
  /** Start removing a project in the background. */
  start: (project: StudioProject, choice: { deleteApp: boolean }) => void
  /** Run a stopped removal again from the step that failed. */
  retry: (projectId: string) => void
  /** Forget a stopped removal; the project stays. */
  dismiss: (projectId: string) => void
}

interface Options {
  /** Refresh the app's sign-in state after a sign-in. Rejecting stops the removal. */
  onSignedIn?: () => Promise<void> | void
  /** Free whatever holds the project's files (a live preview) before the folder moves. */
  beforeTrash?: (project: StudioProject) => Promise<void> | void
  /** The project is gone. `appDeleted` is true when its published app was deleted too. */
  onRemoved: (project: StudioProject, next: ProjectsState, appDeleted: boolean) => void
  /** The removal stopped; the project stays. */
  onFailed?: (project: StudioProject, error: string) => void
}

/** Deleting the published app gives up after this long, so it can't hang. */
const APP_TIMEOUT_MS = 130_000

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (reason) => {
        clearTimeout(timer)
        reject(reason)
      }
    )
  })
}

function appFailure(result: FabricDeleteResult): string {
  if (result.needsLogin) return 'Your Fabric session expired. Sign in to Fabric and try again.'
  return result.failures[0]?.error ?? result.error ?? 'Couldn’t delete the published app.'
}

/**
 * The projects without one that's been removed. It's applied to the current
 * state rather than the removal's own snapshot, which can predate other changes
 * (another removal finishing, a rename).
 */
export function withoutProject(state: ProjectsState, id: string): ProjectsState {
  return {
    ...state,
    projects: state.projects.filter((project) => project.id !== id),
    activeProjectId: state.activeProjectId === id ? null : state.activeProjectId
  }
}

/** What a removal is doing, in a few words, for its project's row. */
export function removalStatus(removal: ProjectRemoval, now: number): string {
  if (removal.error) return removal.error
  if (removal.step === 'signin') return 'Waiting for you to sign in to Fabric…'
  if (removal.step === 'app') {
    return removal.project.workspaceName
      ? `Deleting the published app from ${removal.project.workspaceName}…`
      : 'Deleting the published app…'
  }
  const progress = removal.progress
  if (!progress) return 'Moving the folder to trash…'
  if (progress.phase === 'scanning') {
    return `Counting files… ${progress.processed.toLocaleString()}`
  }
  const files = (progress.total ?? progress.processed).toLocaleString()
  const seconds = removal.trashingSince ? Math.floor((now - removal.trashingSince) / 1000) : 0
  return seconds > 0
    ? `Moving ${files} files to trash… ${seconds}s`
    : `Moving ${files} files to trash…`
}

/**
 * Removes projects in the background, any number at once. Fabricator runs one
 * Fabric sign-in at a time, so removals that need one share it.
 */
export function useProjectRemovals(options: Options): ProjectRemovals {
  const optionsRef = useRef(options)
  optionsRef.current = options
  const mountedRef = useRef(true)
  /** The source of truth, read by runs as they go; state mirrors it for rendering. */
  const entriesRef = useRef<Record<string, ProjectRemoval>>({})
  const [removals, setRemovals] = useState<Readonly<Record<string, ProjectRemoval>>>({})
  /** Projects with a run in flight. */
  const runningRef = useRef(new Set<string>())
  const signInRef = useRef<Promise<string | null> | null>(null)
  /** Bumped by each completed sign-in, so a delete that started before one retries without another. */
  const signInsRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const write = useCallback((id: string, entry: ProjectRemoval | null): void => {
    const all = { ...entriesRef.current }
    if (entry) all[id] = entry
    else delete all[id]
    entriesRef.current = all
    if (mountedRef.current) setRemovals(all)
  }, [])

  const patch = useCallback(
    (id: string, change: Partial<ProjectRemoval>): void => {
      const entry = entriesRef.current[id]
      if (entry) write(id, { ...entry, ...change })
    },
    [write]
  )

  // Listen for the folders' file counts only while something is being removed.
  const removing = Object.keys(removals).length > 0
  useEffect(() => {
    if (!removing) return
    return window.api.onDeleteProgress((event) => {
      const entry = entriesRef.current[event.id]
      if (!entry || entry.error || entry.step !== 'folder') return
      patch(event.id, {
        progress: event,
        trashingSince:
          event.phase === 'trashing' ? (entry.trashingSince ?? Date.now()) : entry.trashingSince
      })
    })
  }, [removing, patch])

  /** Resolves to why sign-in failed, or null once signed in. */
  const signIn = useCallback((): Promise<string | null> => {
    if (!signInRef.current) {
      const attempt = (async (): Promise<string | null> => {
        try {
          const login = await window.api.auth.loginRayfin()
          if (!login.ok) {
            return authErrorMessage(login.error, 'Fabric sign-in didn’t finish. Please try again.')
          }
          if (!mountedRef.current) return 'Fabricator closed before the sign-in finished.'
          await optionsRef.current.onSignedIn?.()
          signInsRef.current += 1
          return null
        } catch (reason) {
          return authErrorMessage(reason, 'Couldn’t confirm the Fabric sign-in. Please try again.')
        }
      })()
      signInRef.current = attempt
      void attempt.finally(() => {
        if (signInRef.current === attempt) signInRef.current = null
      })
    }
    return signInRef.current
  }, [])

  const run = useCallback(
    async (id: string): Promise<void> => {
      const entry = entriesRef.current[id]
      if (!entry || runningRef.current.has(id)) return
      runningRef.current.add(id)
      const { project } = entry
      const fail = (step: ProjectRemoval['step'], error: string): void => {
        patch(id, { step, error, progress: undefined, trashingSince: undefined })
        optionsRef.current.onFailed?.(project, error)
      }
      try {
        if (entry.deleteApp && !entry.appDeleted) {
          patch(id, { step: 'app', error: undefined })
          const signIns = signInsRef.current
          let result: FabricDeleteResult
          try {
            result = await withTimeout(window.api.fabric.deleteApps(id), APP_TIMEOUT_MS)
            if (!mountedRef.current) return
            if (!result.ok && result.needsLogin) {
              // Sign in, unless someone signed in while this delete ran.
              if (signInsRef.current === signIns) {
                patch(id, { step: 'signin' })
                const signInError = await signIn()
                if (!mountedRef.current) return
                if (signInError) {
                  fail('app', signInError)
                  return
                }
              }
              patch(id, { step: 'app' })
              result = await withTimeout(window.api.fabric.deleteApps(id), APP_TIMEOUT_MS)
              if (!mountedRef.current) return
            }
          } catch (reason) {
            if (!mountedRef.current) return
            fail(
              'app',
              reason instanceof Error && reason.message === 'timeout'
                ? 'Deleting the published app is taking too long. It may be a slow connection; try again.'
                : authErrorMessage(reason, 'Couldn’t delete the published app. Please try again.')
            )
            return
          }
          if (!result.ok) {
            fail('app', appFailure(result))
            return
          }
          patch(id, { appDeleted: true })
        }

        patch(id, {
          step: 'folder',
          error: undefined,
          progress: undefined,
          trashingSince: undefined
        })
        let next: ProjectsState
        try {
          await optionsRef.current.beforeTrash?.(project)
          next = await window.api.projects.remove(id, true)
        } catch (reason) {
          if (!mountedRef.current) return
          fail(
            'folder',
            authErrorMessage(reason, 'Couldn’t move the folder to trash. Please try again.')
          )
          return
        }
        if (!mountedRef.current) return
        const appDeleted = entriesRef.current[id]?.appDeleted ?? false
        write(id, null)
        optionsRef.current.onRemoved(project, next, appDeleted)
      } finally {
        runningRef.current.delete(id)
      }
    },
    [patch, signIn, write]
  )

  const start = useCallback(
    (project: StudioProject, choice: { deleteApp: boolean }): void => {
      if (runningRef.current.has(project.id)) return
      write(project.id, {
        project,
        deleteApp: choice.deleteApp,
        // Started again after it stopped: an app it already deleted stays deleted.
        appDeleted: entriesRef.current[project.id]?.appDeleted ?? false,
        step: choice.deleteApp ? 'app' : 'folder'
      })
      void run(project.id)
    },
    [run, write]
  )

  const retry = useCallback(
    (projectId: string): void => {
      if (!entriesRef.current[projectId]?.error) return
      patch(projectId, { error: undefined })
      void run(projectId)
    },
    [patch, run]
  )

  const dismiss = useCallback(
    (projectId: string): void => {
      if (runningRef.current.has(projectId)) return
      write(projectId, null)
    },
    [write]
  )

  return { removals, start, retry, dismiss }
}
