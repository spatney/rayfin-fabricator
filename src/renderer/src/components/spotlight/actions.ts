// What Search can do: everything here is something the app's own controls do,
// offered only when those controls would be there to use.
import type { StudioProject, ThemePreference } from '@shared/ipc'
import type { ProjectView } from '../AppBar'
import { currentLanguage, i18n, translator } from '../../i18n'
import { UI_SCALES } from '../../theme'
import { HUE, type SearchItem } from './model'

export interface ActionHandlers {
  showView(view: ProjectView): void
  showCodeTab(tab: 'history' | 'skills' | 'secrets'): void
  /** Show the open project's terminal, or put it away. */
  showTerminal(show: boolean): void
  newTerminal(): void
  goHome(): void
  newProject(): void
  openFolder(): void
  cloneFromGitHub(): void
  importProject(): void
  migrateReport(): void
  openGallery(): void
  manageProject(): void
  exportProject(): void
  openOverview(): void
  deploy(): void
  share(): void
  setAutoDeploy(on: boolean): void
  setTheme(theme: ThemePreference): void
  setUiScale(scale: number): void
  openSettings(): void
  openAccounts(): void
  openApiKeys(): void
  openMcpServers(): void
  openChatDefaults(): void
  openCustomInstructions(): void
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
  /** The open project's terminal is showing. */
  terminalOpen?: boolean
  /** The App gallery is showing. */
  inGallery: boolean
  /** The open team app's workspace. */
  teamWorkspaceName?: string
  theme: ThemePreference
  uiScale: number
  fabricSignedIn: boolean
  /** Fabric sign-in runs a project's Rayfin CLI, so it waits until there's a project. */
  canSignInToFabric: boolean
  /** The shortcut modifier as printed on keycaps: Ctrl, or ⌘. */
  modKey: string
  do: ActionHandlers
}

type Action = Omit<SearchItem, 'group'>
/** Words for the actions, in the language shown or in English. */
type Translate = ReturnType<typeof translator<'spotlight'>>

/** The project's views; their titles and subtitles are keys in `spotlight`. */
const VIEWS = [
  {
    view: 'build',
    title: 'act.viewBuild.title',
    icon: 'tools',
    detail: 'act.viewBuild.subtitle',
    keywords: ['chat', 'preview', 'copilot']
  },
  {
    view: 'code',
    title: 'act.viewCode.title',
    icon: 'code',
    detail: 'act.viewCode.subtitle',
    keywords: ['files', 'source', 'editor']
  },
  {
    view: 'blueprint',
    title: 'act.viewBlueprint.title',
    icon: 'type-hierarchy',
    detail: 'act.viewBlueprint.subtitle',
    keywords: ['architecture', 'data model', 'diagram', 'entities', 'connections']
  },
  {
    view: 'advisor',
    title: 'act.viewAdvisor.title',
    icon: 'shield',
    detail: 'act.viewAdvisor.subtitle',
    keywords: ['review', 'issues', 'security', 'checks', 'quality']
  }
] as const satisfies ReadonlyArray<{
  view: ProjectView
  title: string
  icon: string
  detail: string
  keywords: readonly string[]
}>

const THEMES = [
  { theme: 'dark', title: 'act.theme.dark', detail: 'act.theme.appearance' },
  { theme: 'light', title: 'act.theme.light', detail: 'act.theme.appearance' },
  { theme: 'system', title: 'act.theme.system', detail: 'act.theme.systemSubtitle' }
] as const satisfies ReadonlyArray<{ theme: ThemePreference; title: string; detail: string }>

/** The actions that apply right now, in the order they're listed when nothing is typed. */
export function buildActions(ctx: ActionContext): SearchItem[] {
  const actions = actionsIn(ctx, translator('spotlight'))
  if (currentLanguage() === 'en') return actions
  // In another language, an action's English title finds it too, as the docs and
  // people who know the app in English call it.
  const english = new Map(
    actionsIn(ctx, i18n.getFixedT('en', 'spotlight')).map((action) => [action.id, action.title])
  )
  return actions.map((action) => {
    const title = english.get(action.id)
    return title && title !== action.title
      ? { ...action, keywords: [...(action.keywords ?? []), title] }
      : action
  })
}

function actionsIn(ctx: ActionContext, t: Translate): SearchItem[] {
  const actions: Action[] = []
  const { project, do: run } = ctx
  const add = (action: Action): void => {
    actions.push(action)
  }

  if (project && ctx.toolsReady) {
    for (const v of VIEWS) {
      add({
        id: `action:view-${v.view}`,
        title: t(v.title),
        subtitle: t(v.detail, { name: project.name }),
        keywords: v.keywords,
        icon: { kind: 'codicon', name: v.icon },
        hint: ctx.onProjectScreen && ctx.view === v.view ? t('act.current') : undefined,
        run: () => run.showView(v.view)
      })
    }
    add({
      id: 'action:code-history',
      title: t('act.history.title'),
      subtitle: t('act.history.subtitle', { name: project.name }),
      keywords: ['versions', 'changes', 'restore', 'undo', 'commits'],
      icon: { kind: 'codicon', name: 'history' },
      run: () => run.showCodeTab('history')
    })
    add({
      id: 'action:code-skills',
      title: t('act.skills.title'),
      subtitle: t('act.skills.subtitle'),
      keywords: ['instructions', 'guidance', 'rules'],
      icon: { kind: 'codicon', name: 'lightbulb' },
      run: () => run.showCodeTab('skills')
    })
    add({
      id: 'action:code-secrets',
      title: t('act.secrets.title'),
      subtitle: t('act.secrets.subtitle'),
      keywords: ['passwords', 'api keys', 'credentials', 'environment variables'],
      icon: { kind: 'codicon', name: 'lock' },
      run: () => run.showCodeTab('secrets')
    })
  }

  // The terminal works while a project's packages are still being prepared too.
  if (project && !project.missing) {
    const ctrl = ctx.modKey === '⌘' ? '⌃' : t('keys.ctrl')
    add({
      id: 'action:terminal',
      title: ctx.terminalOpen ? t('act.terminal.hide') : t('act.terminal.title'),
      subtitle: ctx.terminalOpen
        ? t('act.terminal.hideSubtitle')
        : t('act.terminal.subtitle', { name: project.name }),
      keywords: [
        'shell',
        'command line',
        'console',
        'powershell',
        'bash',
        'zsh',
        'cmd',
        'cli',
        'npm'
      ],
      icon: { kind: 'codicon', name: 'terminal' },
      keys: [ctrl, '`'],
      run: () => run.showTerminal(!ctx.terminalOpen)
    })
    add({
      id: 'action:new-terminal',
      title: t('act.newTerminal.title'),
      subtitle: t('act.newTerminal.subtitle', { name: project.name }),
      keywords: ['shell', 'command line', 'console', 'powershell', 'bash', 'zsh', 'cmd', 'tab'],
      icon: { kind: 'codicon', name: 'terminal' },
      keys: [ctrl, 'Shift', '`'],
      run: run.newTerminal
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
            ? t('act.deploy.files', { count: files })
            : t('act.deploy.changes')
          : t('act.deploy.title'),
        subtitle: files
          ? t('act.deploy.filesSubtitle', { count: files, name: project.name })
          : ctx.pending?.changed
            ? t('act.deploy.changesSubtitle', { name: project.name })
            : t('act.deploy.subtitle', { name: project.name }),
        // People who know it as deploying still find it.
        keywords: ['deploy', 'redeploy', 'ship', 'fabric'],
        icon: { kind: 'codicon', name: 'rocket' },
        run: run.deploy
      })
    }
    add({
      id: 'action:share',
      title: t('act.share.title'),
      subtitle: t('act.share.subtitle', { name: project.name }),
      keywords: ['invite', 'access', 'link', 'people'],
      icon: { kind: 'codicon', name: 'link' },
      run: run.share
    })
  }
  if (project && ctx.toolsReady && !project.team) {
    add({
      id: 'action:auto-deploy',
      title: ctx.autoDeploy ? t('act.autoDeploy.off') : t('act.autoDeploy.on'),
      subtitle: ctx.autoDeploy ? t('act.autoDeploy.offSubtitle') : t('act.autoDeploy.onSubtitle'),
      keywords: ['auto publish', 'automatic', 'auto deploy', 'manual deploy'],
      icon: { kind: 'codicon', name: 'sync' },
      run: () => run.setAutoDeploy(!ctx.autoDeploy)
    })
  }

  if (project && !ctx.onHome) {
    add({
      id: 'action:home',
      title: t('act.home.title'),
      subtitle: t('act.home.subtitle'),
      keywords: ['home', 'your projects', 'switch project'],
      icon: { kind: 'codicon', name: 'home' },
      run: run.goHome
    })
  }
  add({
    id: 'action:new-project',
    title: t('act.newProject.title'),
    subtitle: t('act.newProject.subtitle'),
    keywords: ['create', 'new app', 'start'],
    icon: { kind: 'codicon', name: 'add' },
    run: run.newProject
  })
  add({
    id: 'action:open-folder',
    title: t('act.openFolder.title'),
    subtitle: t('act.openFolder.subtitle'),
    keywords: ['open project', 'existing'],
    icon: { kind: 'codicon', name: 'folder-opened' },
    run: run.openFolder
  })
  add({
    id: 'action:clone',
    title: t('act.clone.title'),
    subtitle: t('act.clone.subtitle'),
    keywords: ['git', 'repository', 'download'],
    icon: { kind: 'codicon', name: 'repo-clone' },
    run: run.cloneFromGitHub
  })
  add({
    id: 'action:import-project',
    title: t('act.importProject.title'),
    subtitle: t('act.importProject.subtitle'),
    keywords: ['fabricator file', 'zip', 'received', 'sent to me'],
    icon: { kind: 'codicon', name: 'package' },
    run: run.importProject
  })
  if (ctx.migrationEnabled) {
    add({
      id: 'action:migrate',
      title: t('act.migrate.title'),
      subtitle: t('act.migrate.subtitle'),
      keywords: ['power bi', 'report', 'convert'],
      icon: { kind: 'codicon', name: 'graph' },
      run: run.migrateReport
    })
  }
  if (!ctx.inGallery) {
    add({
      id: 'action:gallery',
      title: t('act.gallery.title'),
      subtitle: t('act.gallery.subtitle'),
      keywords: ['fabric apps', 'published apps', 'browse', 'catalog', 'shared with me'],
      icon: { kind: 'codicon', name: 'library' },
      run: run.openGallery
    })
  }
  if (project) {
    add({
      id: 'action:manage-project',
      title: t('act.manageProject.title', { name: project.name }),
      subtitle: t('act.manageProject.subtitle'),
      keywords: ['rename', 'remove', 'delete', 'trash'],
      icon: { kind: 'codicon', name: 'gear' },
      run: run.manageProject
    })
  }
  if (project && !project.team && !project.missing) {
    add({
      id: 'action:export-project',
      title: t('act.exportProject.title', { name: project.name }),
      subtitle: t('act.exportProject.subtitle'),
      keywords: ['send', 'share a copy', 'transfer', 'give', 'hand off', 'handoff', 'zip'],
      icon: { kind: 'codicon', name: 'package' },
      run: run.exportProject
    })
  }
  if (project?.team) {
    const team = ctx.teamWorkspaceName
    add({
      id: 'action:overview',
      title: t('act.overview.title'),
      subtitle:
        team === undefined
          ? t('act.overview.subtitleHere')
          : t('act.overview.subtitle', { name: team }),
      keywords: ['team', 'map', 'members'],
      icon: { kind: 'codicon', name: 'type-hierarchy-sub' },
      run: run.openOverview
    })
  }

  for (const theme of THEMES) {
    add({
      id: `action:theme-${theme.theme}`,
      title: t(theme.title),
      subtitle: t(theme.detail),
      keywords: ['theme', 'appearance', 'dark mode', 'light mode', 'colors'],
      icon: { kind: 'codicon', name: 'color-mode' },
      hint: ctx.theme === theme.theme ? t('act.current') : undefined,
      run: () => run.setTheme(theme.theme)
    })
  }
  for (const scale of UI_SCALES) {
    const percent = Math.round(scale * 100)
    add({
      id: `action:text-size-${percent}`,
      title: t('act.textSize.title', { percent }),
      subtitle: t('act.textSize.subtitle'),
      keywords: ['zoom', 'scale', 'bigger', 'smaller', 'font size'],
      icon: { kind: 'codicon', name: 'text-size' },
      hint: Math.abs(ctx.uiScale - scale) < 0.001 ? t('act.current') : undefined,
      run: () => run.setUiScale(scale)
    })
  }

  add({
    id: 'action:settings',
    title: t('act.settings.title'),
    subtitle: t('act.settings.subtitle'),
    keywords: ['preferences', 'options', 'experiments'],
    icon: { kind: 'codicon', name: 'settings-gear' },
    run: run.openSettings
  })
  add({
    id: 'action:accounts',
    title: t('act.accounts.title'),
    subtitle: t('act.accounts.subtitle'),
    keywords: ['sign in', 'sign out', 'github', 'copilot', 'fabric', 'azure'],
    icon: { kind: 'codicon', name: 'account' },
    run: run.openAccounts
  })
  add({
    id: 'action:api-keys',
    title: t('act.apiKeys.title'),
    subtitle: t('act.apiKeys.subtitle'),
    keywords: ['model providers', 'models', 'byok', 'anthropic', 'openai', 'google', 'xai'],
    icon: { kind: 'codicon', name: 'key' },
    run: run.openApiKeys
  })
  add({
    id: 'action:mcp-servers',
    title: t('act.mcpServers.title'),
    subtitle: t('act.mcpServers.subtitle'),
    keywords: ['mcp', 'model context protocol', 'plugins', 'tools', 'servers'],
    icon: { kind: 'codicon', name: 'plug' },
    run: run.openMcpServers
  })
  add({
    id: 'action:chat-defaults',
    title: t('act.chatDefaults.title'),
    subtitle: t('act.chatDefaults.subtitle'),
    keywords: ['default model', 'models', 'plugins', 'mcp', 'chat', 'new project'],
    icon: { kind: 'codicon', name: 'comment-discussion' },
    run: run.openChatDefaults
  })
  add({
    id: 'action:custom-instructions',
    title: t('act.customInstructions.title'),
    subtitle: t('act.customInstructions.subtitle'),
    keywords: ['instructions', 'rules', 'preferences', 'guidance', 'copilot', 'every app'],
    icon: { kind: 'codicon', name: 'note' },
    run: run.openCustomInstructions
  })
  if (ctx.fabricSignedIn && project) {
    add({
      id: 'action:fabric-refresh',
      title: t('act.fabricRefresh.title'),
      subtitle: t('act.fabricRefresh.subtitle'),
      keywords: ['sign in', 'fabric', 'token', 'credentials', 'login'],
      icon: { kind: 'codicon', name: 'refresh' },
      run: run.refreshFabricAuth
    })
  }
  if (!ctx.fabricSignedIn && ctx.canSignInToFabric) {
    add({
      id: 'action:fabric-sign-in',
      title: t('act.fabricSignIn.title'),
      subtitle: t('act.fabricSignIn.subtitle'),
      keywords: ['login', 'microsoft', 'account'],
      icon: { kind: 'codicon', name: 'sign-in' },
      run: run.signInToFabric
    })
  }
  add({
    id: 'action:setup',
    title: t('act.setup.title'),
    subtitle: t('act.setup.subtitle'),
    keywords: ['doctor', 'tools', 'install', 'requirements'],
    icon: { kind: 'codicon', name: 'checklist' },
    run: run.openSetup
  })

  add({
    id: 'action:help',
    title: t('act.help.title'),
    subtitle: t('act.help.subtitle'),
    keywords: ['support', 'troubleshoot', 'assistant', 'problem'],
    icon: { kind: 'codicon', name: 'comment-discussion' },
    keys: [ctx.modKey, 'J'],
    run: run.openHelp
  })
  add({
    id: 'action:docs',
    title: t('act.docs.title'),
    subtitle: t('act.docs.subtitle'),
    keywords: ['docs', 'guide', 'manual'],
    icon: { kind: 'codicon', name: 'book' },
    verb: t('actions.openInBrowser'),
    run: run.openDocs
  })
  add({
    id: 'action:report-issue',
    title: t('act.reportIssue.title'),
    subtitle: t('act.reportIssue.subtitle'),
    keywords: ['bug', 'feedback', 'github', 'problem'],
    icon: { kind: 'codicon', name: 'bug' },
    verb: t('actions.openInBrowser'),
    run: run.reportIssue
  })
  add({
    id: 'action:export-diagnostics',
    title: t('act.exportDiagnostics.title'),
    subtitle: t('act.exportDiagnostics.subtitle'),
    keywords: ['logs', 'bug report', 'support'],
    icon: { kind: 'codicon', name: 'save' },
    run: run.exportDiagnostics
  })
  add({
    id: 'action:open-logs',
    title: t('act.openLogs.title'),
    subtitle: t('act.openLogs.subtitle'),
    keywords: ['logs', 'diagnostics', 'files'],
    icon: { kind: 'codicon', name: 'folder-opened' },
    verb: t('act.openLogs.verb'),
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
  if (/^(view-|code-|home$|terminal$|new-terminal$)/.test(name)) return HUE.blue
  if (/^(new-project|open-folder|clone|migrate|manage-project|overview)$/.test(name)) {
    return HUE.violet
  }
  if (/^(deploy|share|auto-deploy)$/.test(name)) return HUE.green
  if (/^(theme-|text-size-)/.test(name)) return HUE.amber
  if (/^(settings|accounts|api-keys|fabric-|setup)/.test(name)) return HUE.teal
  // Help and support.
  return HUE.pink
}
