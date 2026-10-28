import { describe, expect, it, vi } from 'vitest'
import type { StudioProject } from '@shared/ipc'
import { buildActions, type ActionContext, type ActionHandlers } from './actions'

const project: StudioProject = {
  id: 'p1',
  name: 'Contoso Expenses',
  path: 'C:\\projects\\contoso',
  addedAt: '2026-10-01T00:00:00Z',
  workspace: 'ws-1',
  lastDeploy: { url: 'https://contoso.example.com', status: 'success' }
}

function context(overrides: Partial<ActionContext> = {}): ActionContext {
  const handlers = new Proxy({} as Record<string, unknown>, {
    get: (target, key: string) => (target[key] ??= vi.fn())
  }) as unknown as ActionHandlers
  return {
    project,
    toolsReady: true,
    onProjectScreen: true,
    onHome: false,
    view: 'build',
    deployed: true,
    deploying: false,
    chatBusy: false,
    autoDeploy: true,
    migrationEnabled: false,
    theme: 'dark',
    uiScale: 1,
    fabricSignedIn: true,
    modKey: 'Ctrl',
    do: handlers,
    ...overrides
  }
}

const ids = (ctx: ActionContext): string[] => buildActions(ctx).map((a) => a.id)

describe('Search actions', () => {
  it('offers starting a project, but nothing about one, when none is open', () => {
    const offered = ids(context({ project: null, onProjectScreen: false, onHome: true }))
    expect(offered).toEqual(
      expect.arrayContaining(['action:new-project', 'action:open-folder', 'action:clone'])
    )
    expect(offered).not.toEqual(expect.arrayContaining(['action:view-code']))
    expect(offered.some((id) => /deploy|share|home|manage/.test(id))).toBe(false)
  })

  it('words a deploy as the deployment control does, and runs it', () => {
    const ctx = context({ pending: { changed: true, files: 3 } })
    const deploy = buildActions(ctx).find((a) => a.id === 'action:deploy')!
    expect(deploy.title).toBe('Deploy 3 changes')
    deploy.run()
    expect(ctx.do.deploy).toHaveBeenCalled()
    expect(buildActions(context()).find((a) => a.id === 'action:deploy')?.title).toBe('Redeploy')
  })

  it('holds a deploy back while Copilot works on the app or one is running', () => {
    expect(ids(context({ chatBusy: true }))).not.toContain('action:deploy')
    expect(ids(context({ deploying: true }))).not.toContain('action:deploy')
  })

  it('offers a team app its overview, not a deploy or Share', () => {
    const team = {
      ...project,
      team: { workspaceId: 'w1', folder: 'apps/contoso' }
    } as StudioProject
    const offered = ids(context({ project: team, teamWorkspaceName: 'Finance' }))
    expect(offered).toContain('action:overview')
    expect(offered).not.toContain('action:deploy')
    expect(offered).not.toContain('action:share')
  })

  it('marks the current view, theme and text size', () => {
    const actions = buildActions(context({ view: 'code', theme: 'light', uiScale: 1.25 }))
    const hinted = actions.filter((a) => a.hint === 'Current').map((a) => a.id)
    expect(hinted).toEqual(['action:view-code', 'action:theme-light', 'action:text-size-125'])
  })

  it('switches deploying after each chat turn the other way', () => {
    const ctx = context({ autoDeploy: true })
    const toggle = buildActions(ctx).find((a) => a.id === 'action:auto-deploy')!
    expect(toggle.title).toBe('Turn off Deploy after each chat turn')
    toggle.run()
    expect(ctx.do.setAutoDeploy).toHaveBeenCalledWith(false)
  })
})
