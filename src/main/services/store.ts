/**
 * Tiny JSON-file persistence for app state (workspace root, tracked projects,
 * active project). Stored under Electron's per-user `userData` directory so it
 * survives restarts without bringing in a native dependency.
 *
 * The app deliberately does NOT persist credentials — each CLI owns its own
 * credential store; we only track project locations and metadata here.
 */

import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import type { ProjectsState, StudioProject, DeployInfo } from '../../shared/ipc'

function storeFile(): string {
  return join(app.getPath('userData'), 'studio.json')
}

function defaults(): ProjectsState {
  return {
    workspaceRoot: join(app.getPath('home'), 'RayfinProjects'),
    activeProjectId: null,
    projects: []
  }
}

let cache: ProjectsState | null = null

/** Load the persisted state (cached after first read). */
export function getState(): ProjectsState {
  if (cache) return cache
  try {
    const raw = readFileSync(storeFile(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<ProjectsState>
    cache = {
      ...defaults(),
      ...parsed,
      projects: Array.isArray(parsed.projects) ? parsed.projects : []
    }
  } catch {
    cache = defaults()
  }
  return cache
}

function persist(next: ProjectsState): ProjectsState {
  cache = next
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(storeFile(), JSON.stringify(next, null, 2), 'utf8')
  return next
}

export function setWorkspaceRoot(path: string): ProjectsState {
  return persist({ ...getState(), workspaceRoot: path })
}

export function setActive(id: string | null): ProjectsState {
  const state = getState()
  if (id && !state.projects.some((p) => p.id === id)) return state
  return persist({ ...state, activeProjectId: id })
}

/** Insert or update a project (matched by id), keeping it at the front. */
export function upsertProject(project: StudioProject): ProjectsState {
  const state = getState()
  const rest = state.projects.filter((p) => p.id !== project.id)
  return persist({ ...state, projects: [project, ...rest] })
}

export function removeProject(id: string): ProjectsState {
  const state = getState()
  const projects = state.projects.filter((p) => p.id !== id)
  const activeProjectId = state.activeProjectId === id ? null : state.activeProjectId
  return persist({ ...state, projects, activeProjectId })
}

export function updateDeploy(id: string, deploy: DeployInfo): ProjectsState {
  const state = getState()
  const projects = state.projects.map((p) =>
    p.id === id ? { ...p, lastDeploy: { ...p.lastDeploy, ...deploy } } : p
  )
  return persist({ ...state, projects })
}
