import { afterEach, describe, expect, it } from 'vitest'
import { setLanguage } from '../../i18n'
import { relativeTime } from './format'

describe('relativeTime', () => {
  const now = Date.parse('2026-09-26T12:00:00.000Z')
  const ago = (seconds: number): string => relativeTime(new Date(now - seconds * 1000).toISOString(), now)

  afterEach(async () => {
    await setLanguage('en')
    localStorage.clear()
  })

  it('says "just now" for the first minute instead of "0m ago"', () => {
    expect([0, 44, 45, 59].map(ago)).toEqual(['just now', 'just now', 'just now', 'just now'])
    expect(ago(60)).toBe('1m ago')
  })

  it('moves to hours and days', () => {
    expect(ago(2 * 3600)).toBe('2h ago')
    expect(ago(3 * 86400)).toBe('3d ago')
    expect(relativeTime(undefined)).toBe('recently')
  })

  it('says it in the interface’s language', async () => {
    await setLanguage('de')
    expect([30, 5 * 60, 86400, 3 * 86400].map(ago)).toEqual([
      'gerade eben',
      'vor 5 Min.',
      'vor 1 Tag',
      'vor 3 Tagen'
    ])
    expect(relativeTime(undefined)).toBe('kürzlich')
    await setLanguage('ja')
    expect(ago(2 * 3600)).toBe('2 時間前')
  })
})
