// Search, as the workbench offers it: its projects and team workspaces, what can be
// done from where you are, and what's worth suggesting before you type.
import type { StudioProject, TeamWorkspace } from '@shared/ipc'
import { DEPLOY_QUESTION, PROMPTS } from '../help/parts'
import { buildActions, type ActionContext, type ActionHandlers } from './actions'
import { projectItems, workspaceItems } from './sources'
import type { AskSuggestion, SearchItem } from './model'

export interface WorkbenchSearchContext extends Omit<ActionContext, 'do'> {
  /** Every known project, most recently used first. */
  projects: readonly StudioProject[]
  /** Team workspaces, when that experiment is on. */
  teamWorkspaces: readonly TeamWorkspace[]
  /** The open app's last deploy didn't finish. */
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
      title: 'Find out why the deploy failed',
      subtitle: `${ctx.project.name}’s last deploy didn’t finish`
    })
  }
  for (const prompt of PROMPTS) {
    if (prompt !== DEPLOY_QUESTION) questions.push({ id: `prompt:${prompt}`, question: prompt })
  }

  return {
    items: [
      ...projectItems(ctx.projects, projectOptions),
      ...workspaceItems(ctx.teamWorkspaces, ctx.do.openWorkspace),
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
