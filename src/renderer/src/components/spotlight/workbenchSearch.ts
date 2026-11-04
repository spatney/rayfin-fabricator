// Search, as the workbench offers it: its projects and team workspaces, the Fabric
// apps the gallery last read, what can be done from where you are, and what's
// worth suggesting before you type.
import type { GalleryApp, StudioProject, TeamWorkspace } from '@shared/ipc'
import { DEPLOY_QUESTION, PROMPTS } from '../help/parts'
import { buildActions, type ActionContext, type ActionHandlers } from './actions'
import { galleryAppItems, projectItems, workspaceItems } from './sources'
import type { AskSuggestion, SearchItem } from './model'

export interface WorkbenchSearchContext extends Omit<ActionContext, 'do'> {
  /** Every known project, most recently used first. */
  projects: readonly StudioProject[]
  /** Team workspaces, when that experiment is on. */
  teamWorkspaces: readonly TeamWorkspace[]
  /** The Fabric apps the gallery last read, with their own addresses once known. */
  galleryApps?: ReadonlyArray<{ app: GalleryApp; address?: string }>
  /** The open app's last publish didn't finish. */
  deployFailed: boolean
  /** Open high and medium Advisor issues in the open app. */
  advisorIssues: number
  do: ActionHandlers & {
    openProject(project: StudioProject): void
    /** Manage any project; one whose folder is gone can only be managed. */
    manage(project: StudioProject): void
    /** Open any project's folder in VS Code. */
    openInEditor(project: StudioProject): void
    openWorkspace(workspace: TeamWorkspace): void
    /** Open a Fabric app's page (or its page in Fabric) in the browser. */
    openGalleryApp?(app: GalleryApp, url: string): void
    /** Open the project on this computer that publishes a Fabric app. */
    openProjectById?(projectId: string): void
  }
}

export interface WorkbenchSearch {
  items: SearchItem[]
  recentProjects: SearchItem[]
  suggestions: SearchItem[]
  questions: AskSuggestion[]
}

const MAX_SUGGESTIONS = 3
const MAX_QUESTIONS = 3

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function workbenchSearch(ctx: WorkbenchSearchContext): WorkbenchSearch {
  const teamNames = new Map(ctx.teamWorkspaces.map((w) => [w.id, w.name]))
  const projectOptions = {
    activeId: ctx.project?.id,
    teamNames,
    open: ctx.do.openProject,
    manage: ctx.do.manage,
    openInEditor: ctx.do.openInEditor
  }
  const actions = buildActions(ctx)
  const action = (id: string): SearchItem | undefined => actions.find((a) => a.id === id)

  const suggestions: SearchItem[] = []
  const add = (item: SearchItem | undefined): void => {
    if (item) suggestions.push(item)
  }
  if (ctx.pending?.changed) add(action('action:deploy'))
  const advisor = action('action:view-advisor')
  if (advisor && ctx.advisorIssues > 0) {
    add({
      ...advisor,
      id: 'suggest:advisor',
      title: `Review ${plural(ctx.advisorIssues, 'Advisor issue')}`,
      subtitle: `High and medium issues are open in ${ctx.project?.name ?? 'this app'}`,
      hint: undefined
    })
  }
  if (!ctx.fabricSignedIn) add(action('action:fabric-sign-in'))
  if (ctx.projects.length === 0) {
    add(action('action:new-project'))
    add(action('action:open-folder'))
    add(action('action:clone'))
  }

  const questions: AskSuggestion[] = []
  if (ctx.deployFailed && ctx.project) {
    questions.push({
      id: 'deploy-failed',
      question: DEPLOY_QUESTION,
      title: 'Find out why publishing failed',
      subtitle: `Couldn’t publish ${ctx.project.name}`
    })
  }
  for (const prompt of PROMPTS) {
    if (prompt !== DEPLOY_QUESTION) questions.push({ id: `prompt:${prompt}`, question: prompt })
  }

  const openGalleryApp = ctx.do.openGalleryApp
  const openProjectById = ctx.do.openProjectById
  const apps =
    ctx.galleryApps && openGalleryApp && openProjectById
      ? galleryAppItems(ctx.galleryApps, { open: openGalleryApp, openProject: openProjectById })
      : []

  return {
    items: [
      ...projectItems(ctx.projects, projectOptions),
      ...workspaceItems(ctx.teamWorkspaces, ctx.do.openWorkspace),
      ...apps,
      ...actions
    ],
    recentProjects: projectItems(
      ctx.projects.filter((p) => !p.missing),
      projectOptions
    ),
    suggestions: suggestions.slice(0, MAX_SUGGESTIONS),
    questions: questions.slice(0, MAX_QUESTIONS)
  }
}
