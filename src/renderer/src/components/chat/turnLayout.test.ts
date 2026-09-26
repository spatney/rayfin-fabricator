import { describe, expect, it } from 'vitest'
import type { ChatSegment, ChatToolCall } from '@shared/ipc'
import { answerText, filesChanged, layoutTurn, workDuration } from './turnLayout'
import type { UIChatMessage } from './types'

const ROOT = 'C:\\p'
const tool = (id: string, name: string, extra: Partial<ChatToolCall> = {}): ChatToolCall => ({
  id,
  name,
  title: `${ROOT}\\src\\${id}.ts`,
  state: 'success',
  ...extra
})
const turn = (
  segments: ChatSegment[] | undefined,
  tools: ChatToolCall[],
  extra: Partial<UIChatMessage> = {}
): UIChatMessage => ({
  id: 'a1',
  role: 'assistant',
  text: (segments ?? []).map((s) => (s.kind === 'text' ? s.text : '')).join(''),
  tools,
  segments,
  pending: false,
  ...extra
})
const kinds = (m: UIChatMessage): string[] => layoutTurn(m).map((b) => b.kind)

describe('layoutTurn', () => {
  it('folds steps and narration into one work log above the final answer', () => {
    const m = turn(
      [
        { kind: 'text', text: 'I’ll check the data layer.' },
        { kind: 'tool', id: 'a' },
        { kind: 'tool', id: 'b' },
        { kind: 'text', text: 'Fixing the import.' },
        { kind: 'tool', id: 'c' },
        { kind: 'text', text: '\n\nDone — the app now saves to Rayfin.' }
      ],
      [tool('a', 'view'), tool('b', 'grep'), tool('c', 'edit')]
    )
    const blocks = layoutTurn(m)
    expect(blocks.map((b) => b.kind)).toEqual(['work', 'answer'])
    const work = blocks[0]
    if (work.kind !== 'work') throw new Error('expected work')
    expect(work.items.map((i) => i.kind)).toEqual(['text', 'tool', 'tool', 'text', 'tool'])
    expect(work.steps).toHaveLength(3)
    expect(work.live).toBe(false)
    expect(answerText(m)).toBe('Done — the app now saves to Rayfin.')
  })

  it('renders a turn without steps as its answer, with any thinking inline', () => {
    const m = turn(
      [
        { kind: 'reasoning', text: 'Considering', elapsedMs: 900 },
        { kind: 'text', text: 'Hi!' }
      ],
      []
    )
    expect(kinds(m)).toEqual(['reasoning', 'answer'])
  })

  it('keeps question cards and interjections in place, splitting the work', () => {
    const m = turn(
      [
        { kind: 'tool', id: 'a' },
        { kind: 'question', id: 'q1' },
        { kind: 'tool', id: 'b' },
        { kind: 'interjection', text: 'also dark mode' },
        { kind: 'tool', id: 'c' },
        { kind: 'text', text: 'All set.' }
      ],
      [tool('a', 'view'), tool('b', 'edit'), tool('c', 'edit')]
    )
    expect(kinds(m)).toEqual(['work', 'question', 'work', 'interjection', 'work', 'answer'])
  })

  it('leaves hidden tools out of the steps', () => {
    const m = turn(
      [
        { kind: 'tool', id: 'q' },
        { kind: 'question', id: 'q1' },
        { kind: 'text', text: 'Thanks' }
      ],
      [tool('q', 'ask_user')]
    )
    expect(kinds(m)).toEqual(['question', 'answer'])
  })

  it('lays out legacy turns (no segments) as steps then answer', () => {
    const m: UIChatMessage = {
      id: 'a',
      role: 'assistant',
      text: 'Done.',
      tools: [tool('a', 'view')],
      pending: false
    }
    expect(kinds(m)).toEqual(['work', 'answer'])
  })

  it('streams the in-progress answer below a live log, and marks live thinking', () => {
    const live = turn(
      [
        { kind: 'tool', id: 'a' },
        { kind: 'text', text: 'Writing' }
      ],
      [tool('a', 'view')],
      { pending: true }
    )
    const [work, answer] = layoutTurn(live)
    expect(work).toMatchObject({ kind: 'work', live: true })
    expect(answer).toMatchObject({ kind: 'answer', streaming: true })

    const thinking = turn(
      [
        { kind: 'tool', id: 'a' },
        { kind: 'reasoning', text: 'Hmm' }
      ],
      [tool('a', 'view')],
      { pending: true }
    )
    const [log] = layoutTurn(thinking)
    if (log.kind !== 'work') throw new Error('expected work')
    expect(log.items[1]).toMatchObject({ kind: 'reasoning', live: true })
  })

  it('uses stable keys so a growing run keeps its identity', () => {
    const before = layoutTurn(
      turn([{ kind: 'tool', id: 'a' }], [tool('a', 'view')], { pending: true })
    )
    const after = layoutTurn(
      turn(
        [
          { kind: 'tool', id: 'a' },
          { kind: 'tool', id: 'b' }
        ],
        [tool('a', 'view'), tool('b', 'view')],
        { pending: true }
      )
    )
    expect(after[0].key).toBe(before[0].key)
  })
})

describe('filesChanged', () => {
  it('aggregates per project file from diffs, skipping failures and outside paths', () => {
    const patch = [
      'diff --git a/C:/p/src/a.ts b/C:/p/src/a.ts',
      '--- a/C:/p/src/a.ts',
      '+++ b/C:/p/src/a.ts',
      '@@ -1,1 +1,2 @@',
      '-x',
      '+y',
      '+z',
      'diff --git a/C:/p/src/new.ts b/C:/p/src/new.ts',
      '--- a/dev/null',
      '+++ b/C:/p/src/new.ts',
      '@@ -1,0 +1,1 @@',
      '+hello'
    ].join('\n')
    const tools = [
      tool('p', 'apply_patch', { diff: patch }),
      tool('e', 'edit', { title: 'C:\\p\\src\\a.ts', added: 1, removed: 0 }),
      tool('f', 'edit', { title: 'C:\\p\\src\\b.ts', state: 'error' }),
      tool('s', 'create', {
        title: 'C:\\Users\\me\\.copilot\\session-state\\x\\plan.md',
        added: 4
      }),
      tool('v', 'view')
    ]
    expect(filesChanged(tools, ROOT)).toEqual([
      { path: 'src/a.ts', status: 'edited', added: 3, removed: 1 },
      { path: 'src/new.ts', status: 'created', added: 1, removed: 0 }
    ])
  })

  it('falls back to tool paths and totals without a diff', () => {
    expect(
      filesChanged([tool('c', 'create', { title: 'C:\\p\\src\\x.ts', added: 40 })], ROOT)
    ).toEqual([{ path: 'src/x.ts', status: 'created', added: 40, removed: undefined }])
  })

  it('never mistakes a legacy step title that is just the tool name for a file', () => {
    expect(filesChanged([tool('p', 'apply_patch', { title: 'apply_patch' })], ROOT)).toEqual([])
    expect(filesChanged([tool('e', 'edit', { title: 'Fix the header' })], ROOT)).toEqual([])
  })
})

describe('workDuration', () => {
  it('prefers the turn duration for a sole log, else the span of step times', () => {
    const steps = [
      tool('a', 'view', { startedAt: 1000, endedAt: 2000 }),
      tool('b', 'view', { startedAt: 2500, endedAt: 9000 })
    ]
    expect(workDuration(steps, 12_000, true)).toBe(12_000)
    expect(workDuration(steps, 12_000, false)).toBe(8000)
    expect(workDuration([tool('a', 'view')], undefined, true)).toBeUndefined()
  })
})
