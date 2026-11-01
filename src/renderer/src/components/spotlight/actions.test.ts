import { describe, expect, it, vi } from 'vitest'
import type { StudioProject } from '@shared/ipc'
import { buildActions, type ActionContext, type ActionHandlers } from './actions'
import { prepare, rank } from './rank'

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
    mcpServersEnabled: false,
    inGallery: false,
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

  it('words a publish as the publish control does, and runs it', () => {
    const ctx = context({ pending: { changed: true, files: 3 } })
    const deploy = buildActions(ctx).find((a) => a.id === 'action:deploy')!
    expect(deploy.title).toBe('Publish 3 changes')
    deploy.run()
    expect(ctx.do.deploy).toHaveBeenCalled()
    expect(buildActions(context()).find((a) => a.id === 'action:deploy')?.title).toBe('Publish')
  })

  it('still finds Publish for someone who types deploy', () => {
    const prepared = prepare(buildActions(context()))
    const top = (query: string): string | undefined => rank(prepared, query)[0]?.item.id
    expect(top('deploy')).toBe('action:deploy')
    expect(top('redeploy')).toBe('action:deploy')
    expect(top('deploy after each chat turn')).toBe('action:auto-deploy')
  })

  it('holds publishing back while Copilot works on the app or a publish is running', () => {
    expect(ids(context({ chatBusy: true }))).not.toContain('action:deploy')
    expect(ids(context({ deploying: true }))).not.toContain('action:deploy')
  })

  it('offers a team app its overview, not Publish or Share', () => {
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

  it('switches publishing after each chat turn the other way', () => {
    const ctx = context({ autoDeploy: true })
    const toggle = buildActions(ctx).find((a) => a.id === 'action:auto-deploy')!
    expect(toggle.title).toBe('Turn off Publish after each chat turn')
    toggle.run()
    expect(ctx.do.setAutoDeploy).toHaveBeenCalledWith(false)
  })

  it('offers the app gallery, except from the gallery itself', () => {
    const ctx = context()
    const gallery = buildActions(ctx).find((a) => a.id === 'action:gallery')!
    gallery.run()
    expect(ctx.do.openGallery).toHaveBeenCalled()
    expect(rank(prepare(buildActions(ctx)), 'fabric apps')[0]?.item.id).toBe('action:gallery')
    expect(ids(context({ inGallery: true }))).not.toContain('action:gallery')
  })

  it('offers managing MCP servers only with their experiment', () => {
    expect(ids(context())).not.toContain('action:mcp-servers')
    const ctx = context({ mcpServersEnabled: true })
    const manage = buildActions(ctx).find((a) => a.id === 'action:mcp-servers')!
    manage.run()
    expect(ctx.do.openMcpServers).toHaveBeenCalled()
    expect(rank(prepare(buildActions(ctx)), 'mcp')[0]?.item.id).toBe('action:mcp-servers')
  })

  it('exports the open app, and imports one from anywhere', () => {
    const ctx = context()
    const prepared = prepare(buildActions(ctx))
    const top = (query: string): string | undefined => rank(prepared, query)[0]?.item.id
    expect(top('export contoso')).toBe('action:export-project')
    expect(top('hand off')).toBe('action:export-project')
    expect(top('import')).toBe('action:import-project')
    buildActions(ctx)
      .find((a) => a.id === 'action:export-project')!
      .run()
    expect(ctx.do.exportProject).toHaveBeenCalled()

    const none = context({ project: null, onProjectScreen: false, onHome: true })
    expect(ids(none)).not.toContain('action:export-project')
    expect(ids(none)).toContain('action:import-project')
    const team = {
      ...project,
      team: { workspaceId: 'w1', folder: 'apps/contoso' }
    } as StudioProject
    expect(ids(context({ project: team }))).not.toContain('action:export-project')
  })
})
