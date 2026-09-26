import { describe, expect, it } from 'vitest'
import type { ChatToolCall } from '@shared/ipc'
import { describeStep, isHiddenTool, stepLabel, summarizeKinds, toolKind } from './toolPresentation'

const ROOT = 'C:\\Users\\sachi\\RayfinProjects\\df55-app'
const tool = (name: string, title: string, extra: Partial<ChatToolCall> = {}): ChatToolCall => ({
  id: `${name}-${title}`,
  name,
  title,
  state: 'success',
  ...extra
})

describe('toolKind', () => {
  it('classifies every tool name seen in real transcripts', () => {
    const cases: Record<string, string> = {
      view: 'read',
      powershell: 'run',
      bash: 'run',
      edit: 'edit',
      apply_patch: 'edit',
      str_replace_editor: 'edit',
      create: 'create',
      grep: 'search',
      rg: 'search',
      glob: 'find',
      sql: 'todo',
      skill: 'skill',
      web_fetch: 'web',
      web_search: 'web-search',
      read_powershell: 'shell-io',
      write_powershell: 'shell-io',
      task: 'agent',
      read_agent: 'agent',
      fabricator_locate_semantic_model: 'model',
      fabricator_search_semantic_models: 'model',
      fabricator_design_report: 'design',
      fabricator_screenshot: 'screenshot',
      fabricator_navigate: 'navigate',
      fabricator_deploy_and_wait: 'deploy',
      fabricator_console: 'console',
      mystery_tool: 'other'
    }
    for (const [name, kind] of Object.entries(cases))
      expect([name, toolKind(name)]).toEqual([name, kind])
  })

  it('hides tools whose UI lives elsewhere', () => {
    expect(isHiddenTool('ask_user')).toBe(true)
    expect(isHiddenTool('exit_plan_mode')).toBe(true)
    expect(isHiddenTool('view')).toBe(false)
  })
})

describe('describeStep', () => {
  it('shows project files as a relative dir + name, with diff stats', () => {
    const step = describeStep(
      tool('edit', `${ROOT}\\src\\App.tsx`, { added: 12, removed: 3 }),
      ROOT
    )
    expect(step.verb).toBe('Edited')
    expect(step.target).toEqual({
      kind: 'path',
      path: { dir: 'src/', base: 'App.tsx', rel: 'src/App.tsx', full: `${ROOT}\\src\\App.tsx` }
    })
    expect([step.added, step.removed]).toEqual([12, 3])
    expect(stepLabel(step)).toBe('Edited src/App.tsx')
  })

  it('uses progressive verbs while running', () => {
    expect(describeStep(tool('view', `${ROOT}\\a.ts`, { state: 'running' }), ROOT).verb).toBe(
      'Reading'
    )
    expect(stepLabel(describeStep(tool('grep', 'salesModel', { state: 'running' }), ROOT))).toBe(
      'Searching for “salesModel”'
    )
  })

  it('counts extra files in multi-file patches', () => {
    const step = describeStep(
      tool('apply_patch', `${ROOT}\\a.ts`, { paths: [`${ROOT}\\a.ts`, `${ROOT}\\b.ts`] }),
      ROOT
    )
    expect(step.moreFiles).toBe(1)
  })

  it('quotes search patterns and uses plain phrasing when there is no target', () => {
    expect(stepLabel(describeStep(tool('glob', '**/*.ts'), ROOT))).toBe(
      'Found files matching “**/*.ts”'
    )
    expect(stepLabel(describeStep(tool('grep', 'grep'), ROOT))).toBe('Searched the project')
    expect(stepLabel(describeStep(tool('glob', 'glob'), ROOT))).toBe('Found files')
    expect(stepLabel(describeStep(tool('apply_patch', 'apply_patch'), ROOT))).toBe('Edited files')
    expect(stepLabel(describeStep(tool('view', ROOT), ROOT))).toBe('Read project folder')
  })

  it('describes commands, web pages, skills and Fabricator tools in plain words', () => {
    expect(
      stepLabel(describeStep(tool('powershell', 'Build the app', { exitCode: 2 }), ROOT))
    ).toBe('Ran Build the app')
    expect(describeStep(tool('powershell', 'Build', { exitCode: 2 }), ROOT).failedExit).toBe(2)
    expect(
      describeStep(tool('powershell', 'Build', { exitCode: 0 }), ROOT).failedExit
    ).toBeUndefined()
    expect(
      stepLabel(describeStep(tool('web_fetch', 'https://www.rayfin.ai/docs/llms.txt'), ROOT))
    ).toBe('Read rayfin.ai/docs/llms.txt')
    expect(stepLabel(describeStep(tool('skill', 'data-modeling'), ROOT))).toBe(
      'Used the skill data-modeling'
    )
    expect(stepLabel(describeStep(tool('sql', 'Track database work'), ROOT))).toBe(
      'Updated the task list'
    )
    expect(
      stepLabel(
        describeStep(tool('fabricator_deploy_and_wait', 'fabricator_deploy_and_wait'), ROOT)
      )
    ).toBe('Deployed the app')
    expect(stepLabel(describeStep(tool('mystery_tool', 'mystery_tool'), ROOT))).toBe(
      'Used mystery tool'
    )
    expect(
      stepLabel(
        describeStep(tool('write_powershell', 'write_powershell', { state: 'running' }), ROOT)
      )
    ).toBe('Sending input to a command')
  })

  it('reports step durations from renderer timestamps', () => {
    expect(
      describeStep(tool('powershell', 'Build', { startedAt: 1000, endedAt: 35_000 }), ROOT)
        .durationMs
    ).toBe(34_000)
    expect(
      describeStep(tool('powershell', 'Build', { startedAt: 1000 }), ROOT).durationMs
    ).toBeUndefined()
  })
})

describe('summarizeKinds', () => {
  it('groups steps into header counts', () => {
    const tools = [
      tool('view', 'a'),
      tool('view', 'b'),
      tool('edit', 'a'),
      tool('apply_patch', 'b'),
      tool('powershell', 'x'),
      tool('grep', 'x'),
      tool('glob', 'y'),
      tool('web_fetch', 'u'),
      tool('sql', 'z')
    ]
    expect(summarizeKinds(tools).map((k) => k.label)).toEqual([
      'Read 2 files',
      'Made 2 edits',
      'Ran 1 command',
      'Ran 2 searches',
      'Read 1 web page'
    ])
  })
})
