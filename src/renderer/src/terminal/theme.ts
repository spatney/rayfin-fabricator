import type { ITheme } from '@xterm/xterm'

// The terminal's colors follow the app's theme: its code well, text and accent,
// and an ANSI palette drawn from the app's syntax colors, flat and low in hue.

type Palette = Required<
  Pick<
    ITheme,
    | 'black'
    | 'red'
    | 'green'
    | 'yellow'
    | 'blue'
    | 'magenta'
    | 'cyan'
    | 'white'
    | 'brightBlack'
    | 'brightRed'
    | 'brightGreen'
    | 'brightYellow'
    | 'brightBlue'
    | 'brightMagenta'
    | 'brightCyan'
    | 'brightWhite'
  >
>

const DARK: Palette = {
  black: '#1a1f2b',
  red: '#f0716a',
  green: '#7fd49a',
  yellow: '#e8c069',
  blue: '#5aa4f0',
  magenta: '#c39af0',
  cyan: '#56c2c7',
  white: '#c7d0e0',
  brightBlack: '#6b7488',
  brightRed: '#ff8f87',
  brightGreen: '#a3e6b7',
  brightYellow: '#f5d58b',
  brightBlue: '#8cc2ff',
  brightMagenta: '#dabcff',
  brightCyan: '#86dde0',
  brightWhite: '#eceff5'
}

const LIGHT: Palette = {
  black: '#1f2328',
  red: '#c42b1c',
  green: '#116329',
  yellow: '#8a5d00',
  blue: '#0550ae',
  magenta: '#8250df',
  cyan: '#0e7490',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#d93a30',
  brightGreen: '#1a7f37',
  brightYellow: '#a9750a',
  brightBlue: '#0969da',
  brightMagenta: '#a475f9',
  brightCyan: '#1aa1be',
  brightWhite: '#8c959f'
}

/** Search highlights, which xterm.js takes as `#rrggbb`. */
export interface SearchColors {
  match: string
  active: string
  ruler: string
}

export function isLightTheme(): boolean {
  return document.documentElement.dataset.theme === 'light'
}

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

export function terminalTheme(): ITheme {
  const light = isLightTheme()
  const background = cssVar('--code-bg', light ? '#f6f8fa' : '#0a0d13')
  const accent = cssVar('--accent', light ? '#0f6cbd' : '#35a3ea')
  return {
    ...(light ? LIGHT : DARK),
    background,
    foreground: cssVar('--code-text', light ? '#1f2328' : '#c7d0e0'),
    cursor: accent,
    cursorAccent: background,
    selectionBackground: light ? '#0f6cbd33' : '#35a3ea4d',
    selectionInactiveBackground: light ? '#0f6cbd1f' : '#35a3ea2b',
    scrollbarSliderBackground: light ? '#767f9140' : '#6b748840',
    scrollbarSliderHoverBackground: light ? '#767f9170' : '#6b748870',
    scrollbarSliderActiveBackground: light ? '#767f9190' : '#6b748890'
  }
}

export function searchColors(): SearchColors {
  return isLightTheme()
    ? { match: '#cfe3f7', active: '#8fc0ef', ruler: '#0f6cbd' }
    : { match: '#203b52', active: '#2f6c9e', ruler: '#35a3ea' }
}
