// What Search can do: everything here is something the app's own controls do,
// offered only when those controls would be there to use.
import type { StudioProject, ThemePreference } from '@shared/ipc'
import type { ProjectView } from '../AppBar'
import { UI_SCALES } from '../../theme'
import { HUE, type SearchItem } from './model'

export interface ActionHandlers {
  showView(view: ProjectView): void
  showCodeTab(tab: 'history' | 'skills' | 'secrets'): void
  goHome(): void
  newProject(): void
  openFolder(): void
  cloneFromGitHub(): void
  migrateReport(): void
  manageProject(): void
  openOverview(): void
  deploy(): void
  share(): void
  setAutoDeploy(on: boolean): void
  setTheme(theme: ThemePreference): void
  setUiScale(scale: number): void
  openSettings(): void
  openAccounts(): void
  openApiKeys(): void
  refreshFabricAuth(): void
  signInToFabric(): void
  openSetup(): void
  openHelp(): void
  openDocs(): void
  reportIssue(): void
  exportDiagnostics(): void
  openLogs(): void
}

export interface ActionContext {
  /** The open project, which may be behind Home or a workspace overview. */
  project: StudioProject | null
  /** Its tabs are unlocked: its dependencies are ready. */
  toolsReady: boolean
  /** The project's own screen is showing, rather than Home or an overview. */
  onProjectScreen: boolean
  /** Home is showing. */
  onHome: boolean
  view: ProjectView
  /** The open app has been published to Fabric. */
  deployed: boolean
  deploying: boolean
  /** Copilot is working on the open app, so publishing would have to wait. */
  chatBusy: boolean
  /** What the open app's next publish would ship, when known. */
  pending?: { changed: boolean; files?: number }
  /** Publish after each chat turn. */
  autoDeploy: boolean
  migrationEnabled: boolean
  /** The open team app's workspace. */
  teamWorkspaceName?: string
  theme: ThemePreference
  uiScale: number
  fabricSignedIn: boolean
  /** The shortcut modifier as printed on keycaps: Ctrl, or ⌘. */
  modKey: string
  do: ActionHandlers
}

type Action = Omit<SearchItem, 'group'>

const VIEWS: {
  view: ProjectView
  title: string
  icon: string
  detail: (name: string) => string
  keywords: string[]
}[] = [
  {
    view: 'build',
    title: 'Build',
    icon: 'tools',
    detail: (name) => `Chat with Copilot and preview ${name}`,
    keywords: ['chat', 'preview', 'copilot']
  },
  {
    view: 'code',
    title: 'Code',
    icon: 'code',
    detail: (name) => `Browse the files of ${name}`,
    keywords: ['files', 'source', 'editor']
  },
  {
    view: 'blueprint',
    title: 'Blueprint',
    icon: 'type-hierarchy',
    detail: (name) => `What ${name} is made of, and its data model`,
    keywords: ['architecture', 'data model', 'diagram', 'entities', 'connections']
  },
  {
    view: 'advisor',
    title: 'Advisor',
    icon: 'shield',
    detail: (name) => `Check ${name} for problems before you share it`,
    keywords: ['review', 'issues', 'security', 'checks', 'quality']
  }
]

const THEMES: { theme: ThemePreference; title: string; detail: string }[] = [
  { theme: 'dark', title: 'Dark theme', detail: 'Appearance' },
  { theme: 'light', title: 'Light theme', detail: 'Appearance' },
  { theme: 'system', title: 'System theme', detail: 'Follow your computer’s light or dark setting' }
]

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** The actions that apply right now, in the order they're listed when nothing is typed. */
export function buildActions(ctx: ActionContext): SearchItem[] {
  const actions: Action[] = []
  const { project, do: run } = ctx
  const add = (action: Action): void => {
    actions.push(action)
  }

  if (project && ctx.toolsReady) {
    for (const v of VIEWS) {
      add({
        id: `action:view-${v.view}`,
        title: v.title,
        subtitle: v.detail(project.name),
        keywords: v.keywords,
        icon: { kind: 'codicon', name: v.icon },
        hint: ctx.onProjectScreen && ctx.view === v.view ? 'Current' : undefined,
        run: () => run.showView(v.view)
      })
    }
    add({
      id: 'action:code-history',
      title: 'History',
      subtitle: `Every version of ${project.name}, and what changed`,
      keywords: ['versions', 'changes', 'restore', 'undo', 'commits'],
      icon: { kind: 'codicon', name: 'history' },
      run: () => run.showCodeTab('history')
    })
    add({
      id: 'action:code-skills',
      title: 'Skills',
      subtitle: 'Guidance Copilot follows while it builds this app',
      keywords: ['instructions', 'guidance', 'rules'],
      icon: { kind: 'codicon', name: 'lightbulb' },
      run: () => run.showCodeTab('skills')
    })
    add({
      id: 'action:code-secrets',
      title: 'Secrets',
      subtitle: 'Keys and passwords your app’s functions use',
      keywords: ['passwords', 'api keys', 'credentials', 'environment variables'],
      icon: { kind: 'codicon', name: 'lock' },
      run: () => run.showCodeTab('secrets')
    })
  }

  if (project && ctx.toolsReady && !project.team && ctx.deployed) {
    if (!ctx.deploying && !ctx.chatBusy) {
      const files = ctx.pending?.changed ? ctx.pending.files : undefined
      add({
        id: 'action:deploy',
        // As the publish control words it.
        title: ctx.pending?.changed
          ? files
            ? `Publish ${plural(files, 'change')}`
            : 'Publish changes'
          : 'Publish',
        subtitle: files
          ? `${plural(files, 'file')} changed since ${project.name} was published`
          : ctx.pending?.changed
            ? `Your latest changes aren’t on ${project.name} yet`
            : `Publish ${project.name} again`,
        // People who know it as deploying still find it.
        keywords: ['deploy', 'redeploy', 'ship', 'fabric'],
        icon: { kind: 'codicon', name: 'rocket' },
        run: run.deploy
      })
    }
    add({
      id: 'action:share',
      title: 'Share',
      subtitle: `Give people access to ${project.name}`,
      keywords: ['invite', 'access', 'link', 'people'],
      icon: { kind: 'codicon', name: 'link' },
      run: run.share
    })
  }
  if (project && ctx.toolsReady && !project.team) {
    add({
      id: 'action:auto-deploy',
      title: ctx.autoDeploy
        ? 'Turn off Publish after each chat turn'
        : 'Turn on Publish after each chat turn',
      subtitle: ctx.autoDeploy
        ? 'Keep chat changes on this computer until you publish them'
        : 'Publish what each chat turn changes as it finishes',
      keywords: ['auto publish', 'automatic', 'auto deploy', 'manual deploy'],
      icon: { kind: 'codicon', name: 'sync' },
      run: () => run.setAutoDeploy(!ctx.autoDeploy)
    })
  }

  if (project && !ctx.onHome) {
    add({
      id: 'action:home',
      title: 'All projects',
      subtitle: 'Show every project on Home',
      keywords: ['home', 'your projects', 'switch project'],
      icon: { kind: 'codicon', name: 'home' },
      run: run.goHome
    })
  }
  add({
    id: 'action:new-project',
    title: 'New project',
    subtitle: 'Describe it and Copilot builds it',
    keywords: ['create', 'new app', 'start'],
    icon: { kind: 'codicon', name: 'add' },
    run: run.newProject
  })
  add({
    id: 'action:open-folder',
    title: 'Open folder',
    subtitle: 'Use an existing local project',
    keywords: ['open project', 'existing'],
    icon: { kind: 'codicon', name: 'folder-opened' },
    run: run.openFolder
  })
  add({
    id: 'action:clone',
    title: 'Clone from GitHub',
    subtitle: 'Bring a repository into Fabricator',
    keywords: ['git', 'repository', 'download'],
    icon: { kind: 'codicon', name: 'repo-clone' },
    run: run.cloneFromGitHub
  })
  if (ctx.migrationEnabled) {
    add({
      id: 'action:migrate',
      title: 'Migrate a Power BI report',
      subtitle: 'Turn a report into an app',
      keywords: ['power bi', 'report', 'convert'],
      icon: { kind: 'codicon', name: 'graph' },
      run: run.migrateReport
    })
  }
  if (project) {
    add({
      id: 'action:manage-project',
      title: `Manage ${project.name}`,
      subtitle: 'Rename it, or remove it from Fabricator',
      keywords: ['rename', 'remove', 'delete', 'trash'],
      icon: { kind: 'codicon', name: 'gear' },
      run: run.manageProject
    })
  }
  if (project?.team) {
    add({
      id: 'action:overview',
      title: 'Workspace overview',
      subtitle: `Every app, change and deployment in ${ctx.teamWorkspaceName ?? 'this team workspace'}`,
      keywords: ['team', 'map', 'members'],
      icon: { kind: 'codicon', name: 'type-hierarchy-sub' },
      run: run.openOverview
    })
  }

  for (const t of THEMES) {
    add({
      id: `action:theme-${t.theme}`,
      title: t.title,
      subtitle: t.detail,
      keywords: ['theme', 'appearance', 'dark mode', 'light mode', 'colors'],
      icon: { kind: 'codicon', name: 'color-mode' },
      hint: ctx.theme === t.theme ? 'Current' : undefined,
      run: () => run.setTheme(t.theme)
    })
  }
  for (const scale of UI_SCALES) {
    const percent = Math.round(scale * 100)
    add({
      id: `action:text-size-${percent}`,
      title: `Text size ${percent}%`,
      subtitle: 'Scale the whole interface',
      keywords: ['zoom', 'scale', 'bigger', 'smaller', 'font size'],
      icon: { kind: 'codicon', name: 'text-size' },
      hint: Math.abs(ctx.uiScale - scale) < 0.001 ? 'Current' : undefined,
      run: () => run.setUiScale(scale)
    })
  }

  add({
    id: 'action:settings',
    title: 'Settings',
    subtitle: 'Theme, text size, experiments and more',
    keywords: ['preferences', 'options', 'experiments'],
    icon: { kind: 'codicon', name: 'settings-gear' },
    run: run.openSettings
  })
  add({
    id: 'action:accounts',
    title: 'Manage accounts',
    subtitle: 'See and change every account Fabricator uses',
    keywords: ['sign in', 'sign out', 'github', 'copilot', 'fabric', 'azure'],
    icon: { kind: 'codicon', name: 'account' },
    run: run.openAccounts
  })
  add({
    id: 'action:api-keys',
    title: 'Manage API keys',
    subtitle: 'Use models from Anthropic, OpenAI, xAI and Google with your own keys',
    keywords: ['model providers', 'models', 'byok', 'anthropic', 'openai', 'google', 'xai'],
    icon: { kind: 'codicon', name: 'key' },
    run: run.openApiKeys
  })
  if (ctx.fabricSignedIn && project) {
    add({
      id: 'action:fabric-refresh',
      title: 'Refresh Fabric authentication',
      subtitle: 'Clear the shared Rayfin CLI credentials and sign in again',
      keywords: ['sign in', 'fabric', 'token', 'credentials', 'login'],
      icon: { kind: 'codicon', name: 'refresh' },
      run: run.refreshFabricAuth
    })
  }
  if (!ctx.fabricSignedIn) {
    add({
      id: 'action:fabric-sign-in',
      title: 'Sign in to Fabric',
      subtitle: 'Microsoft Fabric hosts the apps you publish',
      keywords: ['login', 'microsoft', 'account'],
      icon: { kind: 'codicon', name: 'sign-in' },
      run: run.signInToFabric
    })
  }
  add({
    id: 'action:setup',
    title: 'Open setup',
    subtitle: 'Check the tools Fabricator needs and install missing ones',
    keywords: ['doctor', 'tools', 'install', 'requirements'],
    icon: { kind: 'codicon', name: 'checklist' },
    run: run.openSetup
  })

  add({
    id: 'action:help',
    title: 'Open Help',
    subtitle: 'Debug a problem, browse the docs, or report an issue',
    keywords: ['support', 'troubleshoot', 'assistant', 'problem'],
    icon: { kind: 'codicon', name: 'comment-discussion' },
    keys: [ctx.modKey, 'J'],
    run: run.openHelp
  })
  add({
    id: 'action:docs',
    title: 'Documentation',
    subtitle: 'Open the Fabricator docs in your browser',
    keywords: ['docs', 'guide', 'manual'],
    icon: { kind: 'codicon', name: 'book' },
    verb: 'Open in browser',
    run: run.openDocs
  })
  add({
    id: 'action:report-issue',
    title: 'Report an issue',
    subtitle: 'Open a bug report on GitHub with your version details',
    keywords: ['bug', 'feedback', 'github', 'problem'],
    icon: { kind: 'codicon', name: 'bug' },
    verb: 'Open in browser',
    run: run.reportIssue
  })
  add({
    id: 'action:export-diagnostics',
    title: 'Export diagnostics',
    subtitle: 'Save a diagnostics file to attach to a bug report',
    keywords: ['logs', 'bug report', 'support'],
    icon: { kind: 'codicon', name: 'save' },
    run: run.exportDiagnostics
  })
  add({
    id: 'action:open-logs',
    title: 'Open logs folder',
    subtitle: 'Fabricator’s logs on this computer',
    keywords: ['logs', 'diagnostics', 'files'],
    icon: { kind: 'codicon', name: 'folder-opened' },
    verb: 'Open folder',
    run: run.openLogs
  })

  return actions.map((action) => ({
    ...action,
    group: 'actions',
    icon: action.icon.kind === 'codicon' ? { ...action.icon, hue: hueOf(action.id) } : action.icon
  }))
}

/** Each kind of action has its own tile colour, so a long list reads at a glance. */
function hueOf(id: string): number {
  const name = id.replace(/^action:/, '')
  if (/^(view-|code-|home$)/.test(name)) return HUE.blue
  if (/^(new-project|open-folder|clone|migrate|manage-project|overview)$/.test(name)) {
    return HUE.violet
  }
  if (/^(deploy|share|auto-deploy)$/.test(name)) return HUE.green
  if (/^(theme-|text-size-)/.test(name)) return HUE.amber
  if (/^(settings|accounts|api-keys|fabric-|setup)/.test(name)) return HUE.teal
  // Help and support.
  return HUE.pink
}
