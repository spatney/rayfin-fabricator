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
import type { ProjectsState, StudioProject, DeployInfo, AppSettings } from '../../shared/ipc'

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

function defaultSettings(): AppSettings {
  return { theme: 'system', telemetry: false, experiments: { sideThreads: false } }
}

let cache: ProjectsState | null = null
let settingsCache: AppSettings | null = null

/** Read + parse the persisted file once into the projects and settings caches. */
function load(): void {
  try {
    const raw = readFileSync(storeFile(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<ProjectsState> & { settings?: Partial<AppSettings> }
    const { settings, ...projState } = parsed
    cache = {
      ...defaults(),
      ...projState,
      projects: Array.isArray(parsed.projects) ? parsed.projects : []
    }
    settingsCache = { ...defaultSettings(), ...(settings ?? {}) }
  } catch {
    cache = defaults()
    settingsCache = defaultSettings()
  }
}

/** Load the persisted state (cached after first read). */
export function getState(): ProjectsState {
  if (!cache) load()
  return cache as ProjectsState
}

/** Load persisted app settings (cached after first read). */
export function getSettings(): AppSettings {
  if (!settingsCache) load()
  return settingsCache as AppSettings
}

function persist(next: ProjectsState): ProjectsState {
  cache = next
  if (!settingsCache) settingsCache = defaultSettings()
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(storeFile(), JSON.stringify({ ...next, settings: settingsCache }, null, 2), 'utf8')
  return next
}

/** Merge a settings patch and persist. */
export function setSettings(patch: Partial<AppSettings>): AppSettings {
  const current = getSettings()
  const next: AppSettings = {
    ...current,
    ...patch,
    // Deep-merge experiment flags so toggling one doesn't drop the others.
    experiments: { ...current.experiments, ...patch.experiments }
  }
  settingsCache = next
  persist(getState())
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

/** Patch arbitrary fields on a tracked project (e.g. copilotSessionId). */
export function updateProject(id: string, patch: Partial<StudioProject>): ProjectsState {
  const state = getState()
  const projects = state.projects.map((p) => (p.id === id ? { ...p, ...patch, id: p.id } : p))
  return persist({ ...state, projects })
}

/** Look up a tracked project by id. */
export function findProject(id: string): StudioProject | undefined {
  return getState().projects.find((p) => p.id === id)
}
