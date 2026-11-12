// Paths dropped on a terminal, quoted for its shell so it reads them as they
// are: a file named `notes$(calc).txt` stays a name, not a command.

/** How a shell reads a quoted word. */
type Quoting = 'powershell' | 'cmd' | 'posix' | 'fish' | 'nu'

function quotingOf(shellId: string | undefined, windows: boolean): Quoting {
  switch (shellId) {
    case 'pwsh':
    case 'powershell':
      return 'powershell'
    case 'cmd':
    case 'fish':
    case 'nu':
      return shellId
    case undefined:
      // Not known until it starts: the default, PowerShell on Windows, a POSIX shell elsewhere.
      return windows ? 'powershell' : 'posix'
    default:
      return 'posix'
  }
}

// PowerShell takes ‘ ’ ‚ ‛ for ' and “ ” „ for ", and expands `$` and backticks in "…".
const POWERSHELL_SPECIAL = /[\s'"`$&(){}[\];,|<>@#‘’‚‛“”„]/
const POWERSHELL_SINGLE_QUOTES = /['‘’‚‛]/g
// cmd expands %VAR% even inside quotes, and nothing stops that.
const CMD_SPECIAL = /[\s&()^;,=|<>]/
/** A word a POSIX shell or fish reads as it is. */
const PLAIN = /^[\w@%+=:,./-]+$/

function quote(path: string, quoting: Quoting): string {
  switch (quoting) {
    case 'powershell':
      return POWERSHELL_SPECIAL.test(path)
        ? `'${path.replace(POWERSHELL_SINGLE_QUOTES, '$&$&')}'`
        : path
    case 'cmd':
      return CMD_SPECIAL.test(path) ? `"${path}"` : path
    case 'posix':
      return PLAIN.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`
    case 'fish':
      // fish reads \' and \\ inside single quotes.
      return PLAIN.test(path) ? path : `'${path.replace(/[\\']/g, '\\$&')}'`
    case 'nu':
      // nu's double quotes take escapes and never interpolate.
      return `"${path.replace(/[\\"]/g, '\\$&')}"`
  }
}

/** Paths dropped from the OS, quoted for the shell `shellId` names, space-separated. */
export function quotePaths(paths: string[], shellId: string | undefined, windows: boolean): string {
  const quoting = quotingOf(shellId, windows)
  return paths.map((path) => quote(path, quoting)).join(' ')
}
