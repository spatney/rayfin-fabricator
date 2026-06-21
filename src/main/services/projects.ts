/**
 * Project management: scaffolding new Rayfin projects, registering existing ones,
 * detecting the on-disk Rayfin marker, and tracking the active project.
 *
 * On-disk facts (verified against rayfin 1.22):
 *  - A Rayfin project is identified by `rayfin/rayfin.yml` (config lives under the
 *    `rayfin/` folder, not the repo root; the root also has `manifest.json`).
 *  - `rayfin init <dir> -t <template> -y` scaffolds non-interactively and runs
 *    `npm install`, but does NOT create a git repo — we `git init` ourselves.
 */

import { BrowserWindow, dialog } from 'electron'
import { basename, join, resolve } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { run } from './exec'
import * as store from './store'
import type {
  CreateProjectInput,
  ProjectActionResult,
  ProjectsState,
  StudioProject,
  TemplateInfo
} from '../../shared/ipc'

type StreamFn = (stream: 'stdout' | 'stderr', chunk: string) => void

const FALLBACK_TEMPLATES: TemplateInfo[] = [
  { name: 'blankapp', displayName: 'Blank App', description: 'Bare-bones Fabric-authenticated React + Vite app — no data layer.' },
  { name: 'todoapp', displayName: 'Basic Todo App', description: 'End-to-end Fabric-authenticated todo CRUD exercising the full data path.' },
  { name: 'gettingstartedauth', displayName: 'Todo App with Auth + Docs', description: 'Todo app with Fabric auth, Tailwind CSS, and getting-started docs.' },
  { name: 'dataapp', displayName: 'Data App', description: 'Build a data analytics app based on your data in Fabric.' }
]

/** Turn a display name into a safe, predictable folder name. */
function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** True when `dir` looks like a Rayfin project. */
export function isRayfinProject(dir: string): boolean {
  return existsSync(join(dir, 'rayfin', 'rayfin.yml'))
}

const AGENT_INSTRUCTIONS = `# Rayfin Studio — agent guidance

This is a **Rayfin app** (a Microsoft Fabric Backend-as-a-Service app). You are the
coding agent running inside **Rayfin Studio**, a desktop app that drives you plus the
Rayfin CLI to build and deploy this app.

## Rules
- **Make the requested code changes only.** Edit files to implement what the user asks.
- **Do NOT run \`rayfin up\` or otherwise deploy.** Rayfin Studio runs the full
  \`rayfin up\` automatically after your changes and shows the deployed app in its preview.
- Do **not** start dev servers or run the app locally — it is only ever run via deploy.
- Keep the project building; prefer small, correct changes.
- Rayfin project config lives under \`rayfin/\` (e.g. \`rayfin/rayfin.yml\`); the data model
  and services (auth/data/storage/functions/static hosting) are configured there.

When you finish editing, briefly summarize what you changed — Studio handles the deploy.
`

/**
 * Write `.github/copilot-instructions.md` so the Copilot agent edits code only and
 * leaves deploys to Studio. Never clobbers an existing file.
 */
export function ensureAgentInstructions(dir: string): void {
  try {
    const ghDir = join(dir, '.github')
    const file = join(ghDir, 'copilot-instructions.md')
    if (existsSync(file)) return
    if (!existsSync(ghDir)) mkdirSync(ghDir, { recursive: true })
    writeFileSync(file, AGENT_INSTRUCTIONS, 'utf8')
  } catch {
    /* best-effort — the deploy loop still works without it */
  }
}

/** Read the project's display name from rayfin/rayfin.yml (falls back to folder). */
function readProjectName(dir: string): string {
  try {
    const yml = readFileSync(join(dir, 'rayfin', 'rayfin.yml'), 'utf8')
    const match = yml.match(/^name:\s*(.+)$/m)
    if (match) return match[1].trim().replace(/^["']|["']$/g, '')
  } catch {
    /* fall through */
  }
  return basename(dir)
}

/** Read the template id the project was scaffolded from, when recorded. */
function readTemplate(dir: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
      templateId?: string
    }
    return manifest.templateId
  } catch {
    return undefined
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string =>
    resolve(p).replace(/[\\/]+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/** Register a project directory in the store (idempotent by path). */
function registerProject(dir: string, displayName?: string): StudioProject {
  const abs = resolve(dir)
  const existing = store.getState().projects.find((p) => samePath(p.path, abs))
  if (existing) return existing
  const project: StudioProject = {
    id: randomUUID(),
    name: displayName?.trim() || readProjectName(abs),
    path: abs,
    template: readTemplate(abs),
    addedAt: new Date().toISOString()
  }
  store.upsertProject(project)
  return project
}

/** Current state, annotating projects whose folder is missing/invalid. */
export function getProjectsState(): ProjectsState {
  const state = store.getState()
  return {
    ...state,
    projects: state.projects.map((p) => ({ ...p, missing: !isRayfinProject(p.path) }))
  }
}

let templatesCache: TemplateInfo[] | null = null

/** List available templates via the Rayfin CLI (cached; falls back to a static list). */
export async function listTemplates(): Promise<TemplateInfo[]> {
  if (templatesCache) return templatesCache
  const res = await run('rayfin', ['init', '--list-templates'], { timeout: 60_000 })
  try {
    const parsed = JSON.parse(res.stdout) as {
      bundled?: Array<{ name: string; displayName?: string; description?: string }>
    }
    const bundled = parsed.bundled ?? []
    templatesCache = bundled.length
      ? bundled.map((t) => ({
          name: t.name,
          displayName: t.displayName ?? t.name,
          description: t.description ?? ''
        }))
      : FALLBACK_TEMPLATES
  } catch {
    templatesCache = FALLBACK_TEMPLATES
  }
  return templatesCache
}

/** Initialize a git repo with a baseline commit (best-effort). */
async function initGitRepo(dir: string, summary: string, onData?: StreamFn): Promise<void> {
  onData?.('stdout', 'Initializing git repository…\n')
  const init = await run('git', ['init'], { cwd: dir, onData })
  if (!init.ok) return
  await run('git', ['add', '-A'], { cwd: dir })

  // Respect the user's configured identity; supply a local fallback only if unset.
  const email = await run('git', ['config', 'user.email'], { cwd: dir })
  if (!email.stdout.trim()) {
    await run('git', ['config', 'user.email', 'studio@rayfin.local'], { cwd: dir })
    await run('git', ['config', 'user.name', 'Rayfin Studio'], { cwd: dir })
  }
  await run('git', ['commit', '-m', summary], { cwd: dir, onData })
}

/** Scaffold a new Rayfin project, git-init it, and make it active. */
export async function createProject(
  input: CreateProjectInput,
  onData?: StreamFn
): Promise<ProjectActionResult> {
  const name = input.name?.trim()
  if (!name) return { ok: false, error: 'Please enter a project name.' }
  const template = input.template?.trim() || 'blankapp'
  const slug = slugify(name)
  if (!slug) return { ok: false, error: 'Project name must contain letters or numbers.' }

  const root = store.getState().workspaceRoot
  try {
    if (!existsSync(root)) mkdirSync(root, { recursive: true })
  } catch (err) {
    return { ok: false, error: `Could not create workspace folder: ${String(err)}` }
  }

  const dir = join(root, slug)
  if (existsSync(dir)) {
    return { ok: false, error: `A folder named "${slug}" already exists in your workspace.` }
  }

  onData?.('stdout', `Creating "${slug}" from the ${template} template…\n`)
  const init = await run('rayfin', ['init', slug, '-t', template, '-y'], {
    cwd: root,
    onData,
    timeout: 300_000
  })

  if (init.notFound) return { ok: false, error: 'The rayfin CLI was not found on PATH.' }
  if (!init.ok || !isRayfinProject(dir)) {
    return { ok: false, error: `rayfin init failed (exit code ${init.exitCode ?? 'unknown'}).` }
  }

  ensureAgentInstructions(dir)
  await initGitRepo(dir, `Initial commit (${template} template)`, onData)

  const project = registerProject(dir, name)
  store.setActive(project.id)
  onData?.('stdout', '\n✅ Project ready.\n')
  return { ok: true, project: { ...project, missing: false } }
}

/** Register an existing on-disk Rayfin project and make it active. */
export function openProject(path: string): ProjectActionResult {
  const abs = resolve(path)
  if (!existsSync(abs)) return { ok: false, error: 'That folder no longer exists.' }
  if (!isRayfinProject(abs)) {
    return { ok: false, error: 'That folder is not a Rayfin project (no rayfin/rayfin.yml).' }
  }
  ensureAgentInstructions(abs)
  const project = registerProject(abs)
  store.setActive(project.id)
  return { ok: true, project: { ...project, missing: false } }
}

/** Open a native directory picker. Returns the chosen path or null. */
export async function pickFolder(title: string, defaultPath?: string): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const opts = {
    title,
    defaultPath,
    properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>
  }
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (res.canceled || res.filePaths.length === 0) return null
  return res.filePaths[0]
}

export function setWorkspaceRoot(path: string): ProjectsState {
  store.setWorkspaceRoot(resolve(path))
  return getProjectsState()
}

export function setActive(id: string | null): ProjectsState {
  store.setActive(id)
  return getProjectsState()
}

export function removeProject(id: string): ProjectsState {
  store.removeProject(id)
  return getProjectsState()
}
