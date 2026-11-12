import type { LocalLogEvent } from '@shared/ipc'

// The app's output on this computer, as its Output tab prints it: each line
// with its time and source, warnings in yellow and errors in red.

/** Lines the Output tab starts with: all the backend keeps (`RING_CAPACITY`). */
export const OUTPUT_LINES = 2000

/** `rayfin-local`, the longest source, sets the column's width. */
const SOURCE_WIDTH = 12
/** Where a line's text starts, after its time and source. */
const INDENT = ' '.repeat(8 + 1 + SOURCE_WIDTH + 1)

const DIM = '\x1b[90m'
const RESET = '\x1b[0m'
const LEVEL_COLORS: Record<string, string> = {
  debug: '\x1b[2m',
  warn: '\x1b[33m',
  error: '\x1b[31m'
}

/** `HH:MM:SS` in this computer's time zone, or nothing for a time it can't read. */
export function clock(time: string): string {
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return ''
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
}

/* eslint-disable no-control-regex -- escape sequences are what these match */
/** Control sequences (CSI), 8-bit ones too. */
const CSI = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g
/** A color (SGR): the one control sequence that stays. */
const SGR = /^\x1b\[[\d;:]*m$/
/** Strings to their terminator: OSC (titles, links), DCS, SOS, PM and APC. */
const STRINGS = /\x1b[\]PX^_][^\x07\x1b]*(?:\x07|\x1b\\)?/g
/** Any other escape, with its final byte: ESC c resets the terminal. */
const ESCAPES = /\x1b(?!\[[\d;:]*m)[ -/]*[0-~]?/g
/** Other control characters but tab and line feed, and the C1 controls. */
const CONTROLS = /[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f-\x9f]/g
/* eslint-enable no-control-regex */

/**
 * A program's text, safe to print: its colors kept, but nothing that would move
 * the cursor, clear the screen or change the terminal's modes.
 */
export function printable(text: string): string {
  return text
    .replace(CSI, (csi) => (SGR.test(csi) ? csi : ''))
    .replace(STRINGS, '')
    .replace(ESCAPES, '')
    .replace(CONTROLS, '')
}

/** One line of output as the Output tab prints it, ending in a line break. */
export function outputLine(line: LocalLogEvent): string {
  const color = LEVEL_COLORS[line.level] ?? ''
  const text = printable(line.line.replace(/\r\n/g, '\n'))
    .split('\n')
    .join(`${RESET}\r\n${INDENT}${color}`)
  const source = line.source.slice(0, SOURCE_WIDTH).padEnd(SOURCE_WIDTH)
  return `${DIM}${clock(line.time).padEnd(8)} ${source}${RESET} ${color}${text}${RESET}\r\n`
}

/**
 * The lines after `seq` (the newest printed so far), in order and once each, as
 * the Output tab prints them, and the newest `seq` among them. The lines can be
 * the recent ones and those that came while they were read, overlapping.
 */
export function newOutput(lines: LocalLogEvent[], seq: number): { text: string; last: number } {
  let last = seq
  let text = ''
  for (const line of [...lines].sort((a, b) => a.seq - b.seq)) {
    if (line.seq <= last) continue
    last = line.seq
    text += outputLine(line)
  }
  return { text, last }
}
