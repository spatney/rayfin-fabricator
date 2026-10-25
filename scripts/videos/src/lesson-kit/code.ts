/**
 * A small highlighter for the code the lessons show, in the colors of Fabricator's editor
 * (Monaco's dark theme, with bracket pairs colored by depth) and its light twin. Pure and
 * React-free, so tools/code.test.mjs can check it. It's tuned for short, well-formed snippets
 * such as entity classes, client calls and config files, not for every corner of a language.
 */
import type { ThemeName } from '../theme';

export type TokenKind = 'comment' | 'string' | 'keyword' | 'decorator' | 'type' | 'function' | 'property' | 'number' | 'bracket' | 'punct' | 'plain';

/** The languages the highlighter reads. TypeScript unless a snippet says otherwise. */
export type CodeLanguage = 'typescript' | 'yaml' | 'json' | 'plaintext';

export interface Token {
  text: string;
  kind: TokenKind;
  /** For brackets: how deeply nested, from 0. */
  depth?: number;
}

const KEYWORDS = new Set([
  'import', 'from', 'export', 'default', 'class', 'const', 'let', 'var', 'return', 'function', 'async', 'await',
  'new', 'type', 'interface', 'extends', 'implements', 'true', 'false', 'null', 'undefined', 'as', 'if', 'else',
  'for', 'of', 'in', 'typeof', 'this', 'void', 'string', 'number', 'boolean',
]);

const OPEN = '([{';
const CLOSE = ')]}';

/** Splits code into lines of tokens. Block comments may span lines. */
export function tokenize(code: string, language: CodeLanguage = 'typescript'): Token[][] {
  if (language === 'yaml') return tokenizeYaml(code);
  if (language === 'json') return tokenizeJson(code);
  if (language === 'plaintext') return code.replace(/\r\n?/g, '\n').split('\n').map((line) => (line ? [{ text: line, kind: 'plain' as const }] : []));
  return tokenizeTypeScript(code);
}

function tokenizeTypeScript(code: string): Token[][] {
  const lines: Token[][] = [];
  let inBlock = false;
  let depth = 0;
  for (const source of code.replace(/\r\n?/g, '\n').split('\n')) {
    const out: Token[] = [];
    const push = (text: string, kind: TokenKind, d?: number) => {
      const last = out[out.length - 1];
      if (last && last.kind === kind && d === undefined && last.depth === undefined && kind !== 'bracket') last.text += text;
      else out.push(d === undefined ? { text, kind } : { text, kind, depth: d });
    };
    let i = 0;
    const rest = () => source.slice(i);
    while (i < source.length) {
      if (inBlock) {
        const end = source.indexOf('*/', i);
        const stop = end === -1 ? source.length : end + 2;
        push(source.slice(i, stop), 'comment');
        i = stop;
        if (end !== -1) inBlock = false;
        continue;
      }
      const ch = source[i];
      if (source.startsWith('//', i)) {
        push(rest(), 'comment');
        break;
      }
      if (source.startsWith('/*', i)) {
        inBlock = true;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        let j = i + 1;
        while (j < source.length && source[j] !== ch) j += source[j] === '\\' ? 2 : 1;
        push(source.slice(i, Math.min(source.length, j + 1)), 'string');
        i = j + 1;
        continue;
      }
      if (ch === '@') {
        const m = /^@[A-Za-z_$][\w$]*/.exec(rest());
        if (m) {
          push(m[0], 'decorator');
          i += m[0].length;
          continue;
        }
      }
      if (/\d/.test(ch)) {
        const m = /^\d[\d_]*(\.\d+)?/.exec(rest()) as RegExpExecArray;
        push(m[0], 'number');
        i += m[0].length;
        continue;
      }
      if (/[A-Za-z_$]/.test(ch)) {
        const word = (/^[A-Za-z_$][\w$]*/.exec(rest()) as RegExpExecArray)[0];
        const after = source.slice(i + word.length);
        const before = source.slice(0, i).trimEnd();
        let kind: TokenKind = 'plain';
        if (KEYWORDS.has(word) && !before.endsWith('.')) kind = 'keyword';
        else if (/^\s*(<[^>]*>)?\s*\(/.test(after)) kind = /^[A-Z]/.test(word) && before.endsWith('new') ? 'type' : 'function';
        else if (before.endsWith('.')) kind = 'property';
        else if (/^[!?]?:/.test(after) && !/[?]\s*$/.test(before)) kind = 'property';
        else if (/^[A-Z]/.test(word)) kind = 'type';
        push(word, kind);
        i += word.length;
        continue;
      }
      if (OPEN.includes(ch)) {
        push(ch, 'bracket', depth++);
        i++;
        continue;
      }
      if (CLOSE.includes(ch)) {
        depth = Math.max(0, depth - 1);
        push(ch, 'bracket', depth);
        i++;
        continue;
      }
      push(ch, /\s/.test(ch) ? 'plain' : 'punct');
      i++;
    }
    lines.push(out);
  }
  return lines;
}

/** JSON reads like TypeScript, except that a string before a colon is a key, as Monaco colors it. */
function tokenizeJson(code: string): Token[][] {
  return tokenizeTypeScript(code).map((line) =>
    line.map((t, i) => {
      if (t.kind !== 'string') return t;
      const next = line.slice(i + 1).find((n) => n.text.trim());
      return next?.kind === 'punct' && next.text.trimStart().startsWith(':') ? { ...t, kind: 'property' as const } : t;
    }),
  );
}

const YAML_KEYWORDS = new Set(['true', 'True', 'TRUE', 'false', 'False', 'FALSE', 'null', 'Null', 'NULL', '~']);

/**
 * YAML as Monaco's grammar colors it: keys like types, `-` and `:` as punctuation, booleans and
 * null as keywords, numbers as numbers, and every other value, quoted or not, as a string.
 */
function tokenizeYaml(code: string): Token[][] {
  return code
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((source) => {
      const out: Token[] = [];
      const push = (text: string, kind: TokenKind) => {
        if (text) out.push({ text, kind });
      };
      const indent = (/^\s*/.exec(source) as RegExpExecArray)[0];
      push(indent, 'plain');
      let rest = source.slice(indent.length);
      if (rest.startsWith('#')) {
        push(rest, 'comment');
        return out;
      }
      for (let item = /^-(\s+|$)/.exec(rest); item; item = /^-(\s+|$)/.exec(rest)) {
        push('-', 'punct');
        push(item[1], 'plain');
        rest = rest.slice(item[0].length);
      }
      // A comment after a value starts at a `#` that follows whitespace, outside quotes.
      let comment = '';
      const hash = /^((?:"[^"]*"|'[^']*'|[^"'#])*?)\s#/.exec(rest);
      if (hash) {
        comment = rest.slice(hash[1].length);
        rest = hash[1];
      }
      const pair = /^((?:"[^"]*"|'[^']*'|[^#'"])*?)(\s*)(:)(?=\s|$)/.exec(rest);
      if (pair) {
        push(pair[1], 'type');
        push(pair[2], 'plain');
        push(':', 'punct');
        rest = rest.slice(pair[0].length);
        const space = (/^\s*/.exec(rest) as RegExpExecArray)[0];
        push(space, 'plain');
        rest = rest.slice(space.length);
      }
      const value = rest.trimEnd();
      if (value) push(value, YAML_KEYWORDS.has(value) ? 'keyword' : /^[+-]?(\d+|\d*\.\d+)$/.test(value) ? 'number' : 'string');
      push(rest.slice(value.length), 'plain');
      push(comment, 'comment');
      return out;
    });
}

export interface CodePalette {
  bg: string;
  header: string;
  headerText: string;
  border: string;
  gutter: string;
  gutterActive: string;
  /** The line highlight behind focused lines. */
  focusLine: string;
  kinds: Record<Exclude<TokenKind, 'bracket'>, string>;
  /** Bracket pairs, by depth. */
  brackets: readonly [string, string, string];
}

export const CODE_PALETTES: Record<ThemeName, CodePalette> = {
  dark: {
    bg: '#0f1014',
    header: '#12161f',
    headerText: '#e6edf3',
    border: '#263041',
    gutter: '#536576',
    gutterActive: '#c6c6c6',
    focusLine: 'rgba(53,163,234,0.10)',
    kinds: {
      comment: '#6a9955',
      string: '#ce9178',
      keyword: '#569cd6',
      decorator: '#dcdcaa',
      type: '#4ec9b0',
      function: '#dcdcaa',
      property: '#9cdcfe',
      number: '#b5cea8',
      punct: '#d4d4d4',
      plain: '#d4d4d4',
    },
    brackets: ['#ffd700', '#da70d6', '#179fff'],
  },
  light: {
    bg: '#ffffff',
    header: '#f3f5f9',
    headerText: '#12161d',
    border: '#d5dce6',
    gutter: '#6e7781',
    gutterActive: '#0b2540',
    focusLine: 'rgba(15,108,189,0.08)',
    kinds: {
      comment: '#008000',
      string: '#a31515',
      keyword: '#0000ff',
      decorator: '#795e26',
      type: '#267f99',
      function: '#795e26',
      property: '#001080',
      number: '#098658',
      punct: '#000000',
      plain: '#000000',
    },
    brackets: ['#0431fa', '#319331', '#7b3814'],
  },
};

export function colorOf(token: Token, palette: CodePalette): string {
  if (token.kind === 'bracket') return palette.brackets[(token.depth ?? 0) % 3];
  return palette.kinds[token.kind];
}

/**
 * Where a piece of text sits in a snippet: its 1-based line and its 0-based column range.
 * Throws when it isn't there, so a scene can't point at code the snippet no longer has.
 */
export function locate(code: string, text: string, nth = 1): { line: number; from: number; to: number } {
  const lines = code.replace(/\r\n?/g, '\n').split('\n');
  let seen = 0;
  for (let n = 0; n < lines.length; n++) {
    let col = lines[n].indexOf(text);
    while (col !== -1) {
      if (++seen === nth) return { line: n + 1, from: col, to: col + text.length };
      col = lines[n].indexOf(text, col + 1);
    }
  }
  throw new Error(`"${text}" (#${nth}) isn't in the snippet.`);
}
