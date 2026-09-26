import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import Markdown, { MarkdownLinksContext } from './Markdown'
import { splitMentions } from './MentionText'
import PlanQuestionCard from './PlanQuestionCard'

afterEach(() => cleanup())

describe('Markdown', () => {
  it('renders GitHub alerts as callouts and leaves ordinary quotes alone', () => {
    const { container } = render(
      <Markdown>{'> [!WARNING]\n> Sharing needs sign-in.\n\n> Just a quote'}</Markdown>
    )
    const callout = container.querySelector('.md-callout--warning')
    expect(callout?.textContent).toContain('Warning')
    expect(callout?.textContent).toContain('Sharing needs sign-in.')
    expect(callout?.textContent).not.toContain('[!WARNING]')
    expect(container.querySelector('blockquote')?.textContent).toContain('Just a quote')
  })

  it('links inline file paths to the Code tab only when a resolver knows them', async () => {
    const openFile = vi.fn()
    const links = {
      resolveFile: (t: string) => (t === 'src/App.tsx' ? 'src/App.tsx' : null),
      openFile
    }
    render(
      <MarkdownLinksContext.Provider value={links}>
        <Markdown>{'Edit `src/App.tsx`, then run `npm test`.'}</Markdown>
      </MarkdownLinksContext.Provider>
    )
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'src/App.tsx' })))
    expect(openFile).toHaveBeenCalledWith('src/App.tsx')
    expect(screen.getByText('npm test').tagName).toBe('CODE')
  })

  it('renders paths as plain code without a resolver (Advisor, Plan cards)', () => {
    render(<Markdown>{'See `src/App.tsx`.'}</Markdown>)
    expect(screen.getByText('src/App.tsx').tagName).toBe('CODE')
  })

  it('collapses long code blocks behind "Show all" and wraps on demand', async () => {
    const code = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
    const { container } = render(<Markdown>{`\`\`\`ts\n${code}\n\`\`\``}</Markdown>)
    const block = container.querySelector('.md-codeblock')
    expect(block?.classList.contains('is-collapsed')).toBe(true)
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Show all 30 lines' }))
    )
    expect(block?.classList.contains('is-collapsed')).toBe(false)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Wrap long lines' })))
    expect(block?.classList.contains('is-wrap')).toBe(true)
  })

  it('keeps short code blocks open', () => {
    const { container } = render(<Markdown>{'```\nshort\n```'}</Markdown>)
    expect(container.querySelector('.md-codeblock.is-collapsed')).toBeNull()
  })
})

describe('splitMentions', () => {
  it('treats file-like @tokens as mentions, but not npm scopes or trailing punctuation', () => {
    const parts = splitMentions(
      'see @src/App.tsx, then @microsoft/rayfin-cli: and @rayfin/data/Todo.ts'
    )
    expect(parts.filter((p) => p.mention).map((p) => p.text)).toEqual([
      '@src/App.tsx',
      '@rayfin/data/Todo.ts'
    ])
    expect(parts.map((p) => p.text).join('')).toBe(
      'see @src/App.tsx, then @microsoft/rayfin-cli: and @rayfin/data/Todo.ts'
    )
  })

  it('accepts extensionless files the project is known to have', () => {
    expect(splitMentions('open @Dockerfile').some((p) => p.mention)).toBe(false)
    expect(splitMentions('open @Dockerfile', new Set(['Dockerfile'])).some((p) => p.mention)).toBe(
      true
    )
  })
})

describe('PlanQuestionCard', () => {
  it('shows a Recommended badge but answers with the exact choice', async () => {
    const onAnswer = vi.fn()
    render(
      <PlanQuestionCard
        question={{
          id: 'q',
          question: 'Which theme?',
          choices: ['Dark (Recommended)', 'Light'],
          allowFreeform: false,
          state: 'pending'
        }}
        onAnswer={onAnswer}
      />
    )
    const choice = screen.getByRole('button', { name: /^Dark/ })
    expect(choice.textContent).toContain('Recommended')
    expect(choice.textContent).not.toContain('(Recommended)')
    await act(async () => fireEvent.click(choice))
    expect(onAnswer).toHaveBeenCalledWith('q', 'Dark (Recommended)', false)
  })

  it('collapses an answered question to the question and your reply', () => {
    const { container } = render(
      <PlanQuestionCard
        question={{
          id: 'q',
          question: 'Which theme?',
          allowFreeform: true,
          state: 'answered',
          answer: 'Dark, please'
        }}
        onAnswer={vi.fn()}
      />
    )
    expect(container.querySelector('.chat-plan-question-asked')?.textContent).toContain(
      'Which theme?'
    )
    expect(container.querySelector('.chat-plan-question-reply')?.textContent).toBe('Dark, please')
  })
})
