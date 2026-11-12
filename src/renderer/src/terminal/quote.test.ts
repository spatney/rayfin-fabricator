import { describe, expect, it } from 'vitest'
import { quotePaths } from './quote'

describe('quotePaths', () => {
  it('keeps PowerShell from running or expanding what a file name holds', () => {
    const quoted = (path: string): string => quotePaths([path], 'pwsh', true)
    expect(quoted('C:\\app\\notes$(Start-Process calc).txt')).toBe(
      "'C:\\app\\notes$(Start-Process calc).txt'"
    )
    expect(quoted('C:\\app\\~$Budget.xlsx')).toBe("'C:\\app\\~$Budget.xlsx'")
    expect(quoted('C:\\My files\\it’s.txt')).toBe("'C:\\My files\\it’’s.txt'")
    expect(quoted('C:\\app\\src\\App.tsx')).toBe('C:\\app\\src\\App.tsx')
  })

  it('quotes for the platform’s default shell before the shell is known', () => {
    expect(quotePaths(['C:\\a b\\$x.txt'], undefined, true)).toBe("'C:\\a b\\$x.txt'")
    expect(quotePaths(['/Users/me/$(id).txt'], undefined, false)).toBe("'/Users/me/$(id).txt'")
  })

  it('quotes for cmd, POSIX shells, fish and nu', () => {
    expect(quotePaths(['C:\\a b\\c&d.txt'], 'cmd', true)).toBe('"C:\\a b\\c&d.txt"')
    expect(quotePaths(['/Users/me/it’s here/a b.txt', '/tmp/x.txt'], 'zsh', false)).toBe(
      "'/Users/me/it’s here/a b.txt' /tmp/x.txt"
    )
    expect(quotePaths(["/tmp/it's.txt"], 'git-bash', true)).toBe("'/tmp/it'\\''s.txt'")
    expect(quotePaths(["/tmp/a\\'b.txt"], 'fish', false)).toBe("'/tmp/a\\\\\\'b.txt'")
    expect(quotePaths(['/tmp/"a" $b.txt'], 'nu', false)).toBe('"/tmp/\\"a\\" $b.txt"')
  })
})
