import { describe, expect, it, vi } from 'vitest'
import { prepare } from './rank'
import { buildResults, type Entry, type ResultsInput } from './results'
import type { SearchGroup, SearchItem } from './model'

function item(group: SearchGroup, title: string): SearchItem {
  return {
    id: `${group}:${title}`,
    group,
    title,
    icon: { kind: 'codicon', name: 'file' },
    run: vi.fn()
  }
}

const projects = [item('projects', 'Contoso Expenses'), item('projects', 'Deploy Tracker')]
const actions = [item('actions', 'Deploy 3 changes'), item('actions', 'Settings')]
const docs = [
  item('docs', 'Deploy to Microsoft Fabric'),
  item('docs', 'Deployment'),
  item('docs', 'Deploy manually')
]

function input(overrides: Partial<ResultsInput> = {}): ResultsInput {
  return {
    query: '',
    scope: 'all',
    groups: {
      projects: prepare(projects),
      actions: prepare(actions),
      docs: prepare(docs),
      files: []
    },
    lists: { projects, actions, docs, files: [] },
    recentProjects: projects,
    suggestions: [actions[0]],
    questions: [{ id: 'new', question: 'What’s new in this release?' }],
    hasFiles: false,
    helpAvailable: true,
    answering: false,
    ...overrides
  }
}

const sectionsFor = (overrides: Partial<ResultsInput> = {}) =>
  buildResults(input(overrides)).sections
const keys = (sections: ReturnType<typeof sectionsFor>): string[] => sections.map((s) => s.key)
const titles = (entries: Entry[]): string[] =>
  entries.map((e) => (e.type === 'item' ? e.item.title : e.type === 'view' ? e.view : e.type))

describe('what Search shows', () => {
  it('offers suggestions, recent projects, its own searches and questions before anything is typed', () => {
    const sections = sectionsFor({ lastQuestion: 'Why did my deploy fail?' })
    expect(keys(sections)).toEqual(['suggestions', 'recent', 'views', 'ask'])
    // Files are searched only once a project is open.
    expect(titles(sections[2].entries)).toEqual(['projects', 'actions', 'docs'])
    expect(sections[3].entries.map((e) => e.type)).toEqual(['continue', 'ask'])
  })

  it('ranks every kind of result in one list, then offers other ways to use the query', () => {
    const sections = sectionsFor({
      query: 'deploy',
      boost: (i) => (i.group === 'actions' ? 0.05 : 0)
    })
    expect(keys(sections)).toEqual(['results', 'use'])
    expect(titles(sections[0].entries)[0]).toBe('Deploy 3 changes')
    expect(titles(sections[0].entries)).toEqual(
      expect.arrayContaining(['Deploy Tracker', 'Deploy to Microsoft Fabric'])
    )
    expect(sections[1].label).toBe('Use “deploy” with…')
    expect(sections[1].entries).toEqual([
      expect.objectContaining({ type: 'ask', question: 'deploy', main: true }),
      expect.objectContaining({ type: 'view', view: 'projects', count: 1 }),
      expect.objectContaining({ type: 'view', view: 'actions', count: 1 }),
      expect.objectContaining({ type: 'view', view: 'docs', count: 3 })
    ])
  })

  it('offers Help first when the query reads as a question', () => {
    const sections = sectionsFor({ query: 'why does my deploy fail?' })
    expect(sections[0].entries[0]).toMatchObject({
      type: 'ask',
      question: 'why does my deploy fail?'
    })
  })

  it('keeps any one kind from crowding the results, and counts the rest in its own search', () => {
    const many = Array.from({ length: 7 }, (_, i) => item('docs', `Deploy step ${i + 1}`))
    const sections = sectionsFor({
      query: 'step',
      groups: { projects: [], actions: [], docs: prepare(many), files: [] }
    })
    expect(sections[0].entries).toHaveLength(5)
    expect(sections[1].entries[1]).toMatchObject({ type: 'view', view: 'docs', count: 7 })
  })

  it('lists only one kind of thing in its own search, with how many there are', () => {
    const sections = sectionsFor({ query: 'deploy', scope: 'docs' })
    expect(keys(sections)).toEqual(['docs'])
    expect(sections[0]).toMatchObject({ label: 'Documentation', count: 3 })
    expect(buildResults(input({ query: 'deploy', scope: 'docs' })).counts).toEqual({
      projects: 1,
      actions: 1,
      docs: 3,
      files: 0
    })
  })

  it('offers to ask what’s typed in Help, not the starter questions', () => {
    const sections = sectionsFor({ query: 'why is it slow', scope: 'help' })
    expect(sections.flatMap((s) => s.entries)).toEqual([
      expect.objectContaining({ type: 'ask', question: 'why is it slow', main: true })
    ])
  })

  it('says when Help can’t answer because Copilot is signed out', () => {
    const sections = sectionsFor({ query: 'deploy', helpAvailable: false })
    expect(sections[sections.length - 1].entries[0]).toMatchObject({
      subtitle: 'Sign in to GitHub Copilot to ask Help'
    })
  })
})
