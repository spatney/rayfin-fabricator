import { describe, expect, it } from 'vitest'
import type { LocalLogEvent } from '@shared/ipc'
import { newOutput, outputLine, printable } from './output'

const at = new Date(2026, 10, 11, 16, 56, 59).toISOString()
const line = (patch: Partial<LocalLogEvent>): LocalLogEvent => ({
  projectId: 'p1',
  seq: 1,
  source: 'vite',
  level: 'info',
  line: '',
  time: at,
  ...patch
})

describe('outputLine', () => {
  it('prints the time and source in a column, and errors in red', () => {
    expect(outputLine(line({ source: 'rayfin-local', line: 'Ready.' }))).toBe(
      '\x1b[90m16:56:59 rayfin-local\x1b[0m Ready.\x1b[0m\r\n'
    )
    expect(outputLine(line({ level: 'error', line: 'Failed' }))).toBe(
      '\x1b[90m16:56:59 vite        \x1b[0m \x1b[31mFailed\x1b[0m\r\n'
    )
  })

  it('lines up the rest of a line that breaks under its text', () => {
    expect(outputLine(line({ line: 'one\r\ntwo' }))).toBe(
      `\x1b[90m16:56:59 vite        \x1b[0m one\x1b[0m\r\n${' '.repeat(22)}two\x1b[0m\r\n`
    )
  })
})

describe('printable', () => {
  it('keeps colors but drops what would move, clear or retitle the terminal', () => {
    expect(printable('\x1b[32mok\x1b[0m')).toBe('\x1b[32mok\x1b[0m')
    expect(printable('a\x1b[2J\x1b[Hb\x1b]0;title\x07c\x1bcd\re\x9b31mf\x07')).toBe('abcdef')
  })
})

describe('newOutput', () => {
  it('prints the recent lines and those that came meanwhile in order, once each', () => {
    const texts = (output: { text: string }): string[] => output.text.match(/line \d/g) ?? []
    const at = (seq: number): LocalLogEvent => line({ seq, line: `line ${seq}` })
    const caughtUp = newOutput([at(1), at(2), at(3), at(3), at(4)], 0)
    expect(texts(caughtUp)).toEqual(['line 1', 'line 2', 'line 3', 'line 4'])
    expect(caughtUp.last).toBe(4)
    expect(texts(newOutput([at(4)], caughtUp.last))).toEqual([])
    expect(newOutput([at(5)], caughtUp.last)).toMatchObject({ last: 5 })
  })
})
