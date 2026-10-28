// Search's results, built from what the app already knows.
import type { FileNode, StudioProject, TeamWorkspace } from '@shared/ipc'
import type { DocsIndexPage } from 'virtual:docs-index'
import { docsPageUrl } from '../../docsLinks'
import { flattenFiles } from '../chat/mentions'
import { displayPath } from '../projectDisplay'
import { HUE, type ItemAction, type SearchItem } from './model'

/** Files beyond this many aren't searched; a project that big is mostly generated. */
const MAX_FILES = 5000

/** The last part of a path, on either kind of separator. */
function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/** An action that copies `text`, and says so once it has. */
function copy(title: string, text: string, notice: string): ItemAction {
  return {
    id: `copy:${title}`,
    title,
    icon: 'copy',
    notice,
    run: () => navigator.clipboard.writeText(text)
  }
}

export function projectItems(
  projects: readonly StudioProject[],
  options: {
    activeId?: string | null
    /** Team workspaces' names, by id. */
    teamNames: ReadonlyMap<string, string>
    open: (project: StudioProject) => void
    /** A project whose folder is gone can't be opened, only managed. */
    manage: (project: StudioProject) => void
    /** Opens the project's folder in VS Code. */
    openInEditor?: (project: StudioProject) => void
  }
): SearchItem[] {
  return projects.map((project) => {
    const team = project.team
      ? (options.teamNames.get(project.team.workspaceId) ?? 'Team')
      : undefined
    const folder = baseName(project.path)
    const where = displayPath(project.path)
    const actions: ItemAction[] = []
    if (!project.missing && options.openInEditor) {
      const openInEditor = options.openInEditor
      actions.push({
        id: 'vscode',
        title: 'Open in VS Code',
        icon: 'vscode',
        run: () => openInEditor(project)
      })
    }
    actions.push(copy('Copy path', project.path, `Copied ${where}`))
    if (!project.missing) {
      actions.push({
        id: 'manage',
        title: 'Manage project',
        icon: 'gear',
        run: () => options.manage(project)
      })
    }
    return {
      id: `project:${project.id}`,
      group: 'projects',
      title: project.name,
      subtitle: team ? `${team} · team workspace` : where,
      keywords: folder && folder !== project.name ? [folder] : undefined,
      icon: { kind: 'mark', name: project.name },
      verb: project.missing ? 'Manage project' : undefined,
      hint: project.id === options.activeId ? 'Open now' : project.missing ? 'Missing' : undefined,
      actions,
      run: () => (project.missing ? options.manage(project) : options.open(project))
    }
  })
}

export function workspaceItems(
  workspaces: readonly TeamWorkspace[],
  open: (workspace: TeamWorkspace) => void
): SearchItem[] {
  return workspaces.map((workspace) => ({
    id: `workspace:${workspace.id}`,
    group: 'projects',
    title: workspace.name,
    subtitle: workspace.repo,
    keywords: ['team workspace', 'overview'],
    icon: { kind: 'codicon', name: 'organization', hue: HUE.violet },
    kind: 'Workspace',
    verb: 'Open overview',
    actions: [copy('Copy repository', workspace.repo, `Copied ${workspace.repo}`)],
    run: () => open(workspace)
  }))
}

/** Every docs page, and each of its sections. They open in the browser. */
export function docItems(
  pages: readonly DocsIndexPage[],
  open: (url: string) => void
): SearchItem[] {
  const items: SearchItem[] = []
  for (const page of pages) {
    const url = docsPageUrl(page.path)
    items.push({
      id: `doc:${page.path}`,
      group: 'docs',
      title: page.title,
      subtitle: page.section || undefined,
      body: page.description,
      icon: { kind: 'codicon', name: 'book', hue: HUE.blue },
      actions: [copy('Copy link', url, 'Copied the link')],
      run: () => open(url)
    })
    for (const heading of page.headings) {
      const anchor = docsPageUrl(page.path, heading.anchor)
      items.push({
        id: `doc:${page.path}#${heading.anchor}`,
        group: 'docs',
        title: heading.text,
        subtitle: page.title,
        body: heading.snippet || undefined,
        prior: -0.04,
        icon: { kind: 'codicon', name: 'note', hue: HUE.blue },
        actions: [copy('Copy link', anchor, 'Copied the link')],
        run: () => open(anchor)
      })
    }
  }
  return items
}

const CODE = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'mts',
  'cts',
  'py',
  'rs',
  'cs',
  'go',
  'java',
  'sh',
  'ps1'
])
const MEDIA = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'avif'])

/** A file's icon, coloured by what kind of file it is. */
function fileIcon(name: string): { name: string; hue?: number } {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  if (CODE.has(ext)) return { name: 'file-code', hue: HUE.blue }
  if (ext === 'json') return { name: 'json', hue: HUE.amber }
  if (ext === 'md' || ext === 'mdx') return { name: 'markdown' }
  if (MEDIA.has(ext)) return { name: 'file-media', hue: HUE.green }
  if (ext === 'css' || ext === 'scss' || ext === 'less')
    return { name: 'symbol-color', hue: HUE.pink }
  if (ext === 'yml' || ext === 'yaml' || ext === 'toml' || name.startsWith('.env')) {
    return { name: 'gear' }
  }
  return { name: 'file' }
}

/** The open project's files (not the ones git ignores). They open in Code. */
export function fileItems(tree: readonly FileNode[], open: (path: string) => void): SearchItem[] {
  return flattenFiles(tree as FileNode[])
    .slice(0, MAX_FILES)
    .map((file) => {
      const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''
      return {
        id: `file:${file.path}`,
        group: 'files',
        title: file.name,
        subtitle: dir || 'Project folder',
        // So a path ("src/app") finds it too.
        keywords: [file.path],
        icon: { kind: 'codicon', ...fileIcon(file.name) },
        actions: [copy('Copy path', file.path, `Copied ${file.path}`)],
        run: () => open(file.path)
      }
    })
}
