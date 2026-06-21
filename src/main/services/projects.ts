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

import { BrowserWindow, dialog, shell } from 'electron'
import { basename, join, resolve } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { run } from './exec'
import { ensureProjectSkills } from './skills'
import * as store from './store'
import type {
  CreateProjectInput,
  GitCommitResult,
  GitStatus,
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
    await run('git', ['config', 'user.email', 'fabricator@rayfin.local'], { cwd: dir })
    await run('git', ['config', 'user.name', 'Rayfin Fabricator'], { cwd: dir })
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
  const templateName = input.templateName?.trim()
  const isUrl = /^(https?:\/\/|git@|git\+)/i.test(template)
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

  const label = isUrl ? 'community template' : `${template} template`
  onData?.('stdout', `Creating "${slug}" from the ${label}…\n`)
  // `rayfin init -t` takes a built-in name OR a community template URL; for a
  // multi-template source, `--template-name` selects one.
  const initArgs = ['init', slug, '-t', template]
  if (isUrl && templateName) initArgs.push('--template-name', templateName)
  initArgs.push('-y')
  const init = await run('rayfin', initArgs, {
    cwd: root,
    onData,
    timeout: 300_000
  })

  if (init.notFound) return { ok: false, error: 'The rayfin CLI was not found on PATH.' }
  if (!init.ok || !isRayfinProject(dir)) {
    return {
      ok: false,
      error: isUrl
        ? `rayfin init from the template URL failed (exit code ${init.exitCode ?? 'unknown'}). Check the URL is a valid Rayfin template.`
        : `rayfin init failed (exit code ${init.exitCode ?? 'unknown'}).`
    }
  }

  ensureProjectSkills(dir)
  await initGitRepo(dir, `Initial commit (${isUrl ? 'community template' : `${template} template`})`, onData)

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
  ensureProjectSkills(abs)
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

/** Best-effort update of the `name:` field in rayfin/rayfin.yml. */
function writeProjectName(dir: string, name: string): void {
  try {
    const file = join(dir, 'rayfin', 'rayfin.yml')
    const yml = readFileSync(file, 'utf8')
    // Quote names containing characters YAML would otherwise mis-parse.
    const value = /[:#"'\n]/.test(name) ? JSON.stringify(name) : name
    if (/^name:.*$/m.test(yml)) {
      const next = yml.replace(/^name:.*$/m, `name: ${value}`)
      if (next !== yml) writeFileSync(file, next, 'utf8')
    }
  } catch {
    /* best-effort — the display name still updates in the store */
  }
}

/** Rename a project's display name (and rayfin/rayfin.yml `name`). */
export function renameProject(id: string, name: string): ProjectActionResult {
  const project = store.findProject(id)
  if (!project) return { ok: false, error: 'Project not found.' }
  const trimmed = name.trim()
  if (!trimmed) return { ok: false, error: 'Please enter a project name.' }
  writeProjectName(project.path, trimmed)
  store.updateProject(id, { name: trimmed })
  const updated = store.findProject(id) ?? { ...project, name: trimmed }
  return { ok: true, project: { ...updated, missing: !isRayfinProject(updated.path) } }
}

/**
 * Set (or clear, when empty) the Fabric workspace target a project deploys to.
 * Stored on the project and reused by `rayfin up`; switching the active
 * deployment of an already-deployed project should use `deploy.switch` instead.
 * `workspaceName` is an optional friendly label (e.g. the display name) shown
 * in the UI when `workspace` is an opaque GUID.
 */
export function setProjectWorkspace(
  id: string,
  workspace?: string,
  workspaceName?: string
): ProjectActionResult {
  const project = store.findProject(id)
  if (!project) return { ok: false, error: 'Project not found.' }
  const trimmed = workspace?.trim() || undefined
  const label = trimmed ? workspaceName?.trim() || undefined : undefined
  store.updateProject(id, { workspace: trimmed, workspaceName: label })
  const updated = store.findProject(id) ?? { ...project, workspace: trimmed, workspaceName: label }
  return { ok: true, project: { ...updated, missing: !isRayfinProject(updated.path) } }
}

/**
 * Remove a project. By default only forgets it (files stay on disk); when
 * `deleteFiles` is set, the project folder is moved to the OS trash first.
 */
export async function removeProject(id: string, deleteFiles = false): Promise<ProjectsState> {
  const project = store.findProject(id)
  if (deleteFiles && project) {
    try {
      if (existsSync(project.path)) await shell.trashItem(resolve(project.path))
    } catch {
      /* best-effort — still forget the project below */
    }
  }
  store.removeProject(id)
  return getProjectsState()
}

/** Parse `git status --porcelain=v1 --branch` into branch + change count. */
function parseGitStatus(stdout: string): {
  branch?: string
  changedCount: number
  noCommits: boolean
} {
  let branch: string | undefined
  let noCommits = false
  let changedCount = 0
  for (const line of stdout.split('\n')) {
    if (!line) continue
    if (line.startsWith('## ')) {
      const head = line.slice(3).trim()
      const unborn = head.match(/^No commits yet on (.+)$/)
      if (unborn) {
        noCommits = true
        branch = unborn[1].trim()
      } else if (head.startsWith('HEAD (no branch)')) {
        branch = 'detached HEAD'
      } else {
        // "main...origin/main [ahead 1]" → the branch is the token before "..." / space.
        branch = head.split('...')[0].split(' ')[0]
      }
    } else {
      // Each remaining line is one changed/renamed/untracked path.
      changedCount++
    }
  }
  return { branch, changedCount, noCommits }
}

/** Snapshot the project's git working tree (branch + uncommitted change count). */
export async function gitStatus(id: string): Promise<GitStatus> {
  const project = store.findProject(id)
  if (!project || !existsSync(project.path)) return { isRepo: false, changedCount: 0 }
  const res = await run('git', ['status', '--porcelain=v1', '--branch'], {
    cwd: project.path,
    timeout: 30_000
  })
  if (!res.ok) return { isRepo: false, changedCount: 0 }
  const parsed = parseGitStatus(res.stdout)
  return {
    isRepo: true,
    branch: parsed.branch,
    changedCount: parsed.changedCount,
    noCommits: parsed.noCommits || undefined
  }
}

/** Stage everything and commit; resolves with the post-commit status. */
export async function gitCommit(id: string, message: string): Promise<GitCommitResult> {
  const project = store.findProject(id)
  if (!project || !existsSync(project.path)) {
    return { ok: false, error: 'Project folder not found.', status: { isRepo: false, changedCount: 0 } }
  }
  const msg = message.trim()
  if (!msg) return { ok: false, error: 'Enter a commit message.', status: await gitStatus(id) }
  const dir = project.path

  // Scaffolds may lack a committer identity — set a local fallback if missing.
  const email = await run('git', ['config', 'user.email'], { cwd: dir, timeout: 15_000 })
  if (!email.ok || !email.stdout.trim()) {
    await run('git', ['config', 'user.email', 'fabricator@rayfin.local'], { cwd: dir, timeout: 15_000 })
    await run('git', ['config', 'user.name', 'Rayfin Fabricator'], { cwd: dir, timeout: 15_000 })
  }

  const add = await run('git', ['add', '-A'], { cwd: dir, timeout: 30_000 })
  if (!add.ok) {
    return { ok: false, error: add.stderr.trim() || 'git add failed.', status: await gitStatus(id) }
  }

  const commit = await run('git', ['commit', '-m', msg], { cwd: dir, timeout: 30_000 })
  if (!commit.ok) {
    const err = `${commit.stdout}\n${commit.stderr}`.trim()
    const nothing = /nothing to commit|no changes added/i.test(err)
    return {
      ok: false,
      error: nothing ? 'Nothing to commit.' : err || 'git commit failed.',
      status: await gitStatus(id)
    }
  }
  return { ok: true, status: await gitStatus(id) }
}
