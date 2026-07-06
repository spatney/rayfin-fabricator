import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

// Route Monaco's language services to the Vite-bundled web workers. This app runs
// offline from a file:// renderer, so the workers must be local — never the CDN.
;(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case 'json':
        return new JsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker()
      case 'typescript':
      case 'javascript':
        return new TsWorker()
      default:
        return new EditorWorker()
    }
  }
}

// Themes that blend with the Studio palette (see :root / [data-theme='light']).
monaco.editor.defineTheme('rayfin-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#0f1115',
    'editorGutter.background': '#0f1115',
    'editorLineNumber.foreground': '#566074',
    'editorLineNumber.activeForeground': '#9aa3b4',
    'editor.lineHighlightBackground': '#161922',
    'editor.lineHighlightBorder': '#00000000',
    'editorWidget.background': '#161922',
    'editorWidget.border': '#262b3a',
    'editorIndentGuide.background1': '#1c2030',
    'editor.selectionBackground': '#2c4a73',
    'scrollbarSlider.background': '#262b3a80'
  }
})

monaco.editor.defineTheme('rayfin-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#ffffff',
    'editorGutter.background': '#ffffff',
    'editorLineNumber.foreground': '#9aa3b2',
    'editorLineNumber.activeForeground': '#4a5361',
    'editor.lineHighlightBackground': '#f3f5f9',
    'editor.lineHighlightBorder': '#00000000',
    'editorWidget.background': '#ffffff',
    'editorWidget.border': '#d5dce6',
    'editorIndentGuide.background1': '#e7ebf2',
    'editor.selectionBackground': '#c7e5e7',
    'scrollbarSlider.background': '#9aa3b280'
  }
})

// This is a read-only viewer: turn off TS/JS validation so Monaco doesn't spin up
// the language worker just to surface diagnostics we never display.
monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: true
})
monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: true
})

// Tell @monaco-editor/react to use this locally-bundled instance (no CDN fetch).
loader.config({ monaco })

/** Map a file extension to a Monaco language id (falls back to plaintext). */
const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  vue: 'html',
  xml: 'xml',
  svg: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  env: 'ini',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sql: 'sql',
  swift: 'swift',
  kt: 'kotlin',
  lua: 'lua',
  graphql: 'graphql',
  gql: 'graphql',
  dockerfile: 'dockerfile'
}

export function monacoLanguage(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? ''
  if (/^dockerfile/i.test(name)) return 'dockerfile'
  const ext = (name.split('.').pop() ?? '').toLowerCase()
  return EXT_LANG[ext] ?? 'plaintext'
}

export { monaco }
