// Search's results, built from what the app already knows.
import type { FileNode, GalleryApp, StudioProject, TeamWorkspace } from '@shared/ipc'
import type { DocsIndexPage } from 'virtual:docs-index'
import { docsPageUrl } from '../../docsLinks'
import { translator } from '../../i18n'
import { flattenFiles } from '../chat/mentions'
import { displayPath } from '../projectDisplay'
import { HUE, type ItemAction, type SearchItem } from './model'

/** Files beyond this many aren't searched; a project that big is mostly generated. */
const MAX_FILES = 5000

/** The last part of a path, on either kind of separator. */
function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/** An action that copies `text`, and says so once it has. Its id is `copy:<what>`. */
function copy(what: string, title: string, text: string, notice: string): ItemAction {
  return {
    id: `copy:${what}`,
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
  const t = translator('spotlight')
  return projects.map((project) => {
    const team = project.team
      ? (options.teamNames.get(project.team.workspaceId) ?? t('sources.team'))
      : undefined
    const folder = baseName(project.path)
    const where = displayPath(project.path)
    const actions: ItemAction[] = []
    if (!project.missing && options.openInEditor) {
      const openInEditor = options.openInEditor
      actions.push({
        id: 'vscode',
        title: t('sources.openInVsCode'),
        icon: 'vscode',
        run: () => openInEditor(project)
      })
    }
    actions.push(
      copy('path', t('sources.copyPath'), project.path, t('sources.copied', { text: where }))
    )
    if (!project.missing) {
      actions.push({
        id: 'manage',
        title: t('sources.manageProject'),
        icon: 'gear',
        run: () => options.manage(project)
      })
    }
    const live = project.id === options.activeId
    return {
      id: `project:${project.id}`,
      group: 'projects',
      title: project.name,
      subtitle: team ? t('sources.teamWorkspace', { team }) : where,
      keywords: folder && folder !== project.name ? [folder] : undefined,
      icon: { kind: 'mark', name: project.name },
      verb: project.missing ? t('sources.manageProject') : undefined,
      hint: live ? t('sources.openNow') : project.missing ? t('sources.missing') : undefined,
      live: live || undefined,
      actions,
      run: () => (project.missing ? options.manage(project) : options.open(project))
    }
  })
}

export function workspaceItems(
  workspaces: readonly TeamWorkspace[],
  open: (workspace: TeamWorkspace) => void
): SearchItem[] {
  const t = translator('spotlight')
  return workspaces.map((workspace) => ({
    id: `workspace:${workspace.id}`,
    group: 'projects',
    title: workspace.name,
    subtitle: workspace.repo,
    keywords: ['team workspace', 'overview'],
    icon: { kind: 'codicon', name: 'organization', hue: HUE.violet },
    kind: t('sources.workspace'),
    verb: t('sources.openOverview'),
    actions: [
      copy(
        'repo',
        t('sources.copyRepository'),
        workspace.repo,
        t('sources.copied', { text: workspace.repo })
      )
    ],
    run: () => open(workspace)
  }))
}

/**
 * The Fabric apps the gallery last read: Enter opens the live app (or its
 * page in Fabric until its address is known), with Fabric, the project here
 * and its link under Actions.
 */
export function galleryAppItems(
  apps: ReadonlyArray<{ app: GalleryApp; address?: string }>,
  options: {
    /** Open the app's page, or its page in Fabric, in the browser. */
    open: (app: GalleryApp, url: string) => void
    /** Open the project on this computer that publishes it. */
    openProject: (projectId: string) => void
  }
): SearchItem[] {
  const t = translator('spotlight')
  return apps.map(({ app, address }) => {
    const actions: ItemAction[] = []
    if (address) {
      actions.push({
        id: 'fabric',
        title: t('sources.openInFabric'),
        icon: 'globe',
        run: () => options.open(app, app.portalUrl)
      })
    }
    const local = app.local
    if (local) {
      actions.push({
        id: 'project',
        title: t('sources.openInFabricator'),
        icon: 'go-to-file',
        run: () => options.openProject(local.projectId)
      })
    }
    actions.push(
      copy('link', t('sources.copyLink'), address ?? app.portalUrl, t('sources.copiedLink'))
    )
    const keywords = [app.description, local?.projectName, app.team?.name].filter(
      (word): word is string => Boolean(word)
    )
    return {
      id: `fabric-app:${app.id.toLowerCase()}`,
      group: 'apps',
      title: app.name,
      subtitle: local
        ? t('sources.onThisComputer', { workspace: app.workspaceName })
        : app.workspaceName,
      keywords: keywords.length ? keywords : undefined,
      icon: { kind: 'mark', name: app.name },
      verb: address ? t('verbs.apps') : t('sources.openInFabric'),
      actions,
      run: () => options.open(app, address ?? app.portalUrl)
    }
  })
}

/** Every docs page, and each of its sections. They open in the browser. */
export function docItems(
  pages: readonly DocsIndexPage[],
  open: (url: string) => void
): SearchItem[] {
  const t = translator('spotlight')
  const copyTitle = t('sources.copyLink')
  const copied = t('sources.copiedLink')
  const copyLink = (url: string): ItemAction => copy('link', copyTitle, url, copied)
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
      actions: [copyLink(url)],
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
        actions: [copyLink(anchor)],
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
  const t = translator('spotlight')
  const copyTitle = t('sources.copyPath')
  const projectFolder = t('sources.projectFolder')
  return flattenFiles(tree as FileNode[])
    .slice(0, MAX_FILES)
    .map((file) => {
      const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''
      return {
        id: `file:${file.path}`,
        group: 'files',
        title: file.name,
        subtitle: dir || projectFolder,
        // So a path ("src/app") finds it too.
        keywords: [file.path],
        icon: { kind: 'codicon', ...fileIcon(file.name) },
        actions: [copy('path', copyTitle, file.path, t('sources.copied', { text: file.path }))],
        run: () => open(file.path)
      }
    })
}
