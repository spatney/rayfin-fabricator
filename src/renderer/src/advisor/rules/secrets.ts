import type { AdvisorSeverity } from '@shared/ipc'
import { isUnder, relativeTo } from '../../model/projectLayout'
import type { QuickContext } from '../context'
import { maskEnvValues, maskSecrets } from '../mask'
import type { QuickHit, QuickRuleImpl } from '../quick'
import { excerptWindow } from '../quick'
import {
  envEntries,
  isPlaceholderValue,
  isTemplateEnvFile,
  lineOf,
  matchAll,
  type SourceFile
} from '../source'
import { code, lineContaining } from './util'

/** Local env files the CLI and frameworks read (root and `rayfin/`). */
const ENV_FILE = /^(rayfin\/)?\.env(\.[^/]+)?$/
const ENV_NAME = /^\.env(\.[^/]+)?$/
const PUBLIC_PREFIX = /^(VITE_|RAYFIN_PUBLIC_|NEXT_PUBLIC_|PUBLIC_)/
const HIGH_SECRET_NAME =
  /(SECRET|PASSWORD|PASSWD|PRIVATE_KEY|CONNECTION_STRING|CONN_STR|ACCOUNT_KEY|SAS_TOKEN|SERVICE_KEY)/
const MEDIUM_SECRET_NAME = /(API_?KEY|ACCESS_KEY|ACCESS_TOKEN|AUTH_TOKEN|BEARER|_TOKEN$|^TOKEN$)/
const PUBLISHABLE_KEYS = new Set(['VITE_RAYFIN_PUBLISHABLE_KEY', 'RAYFIN_PUBLIC_PUBLISHABLE_KEY'])

const CREDENTIAL_PATTERNS: { re: RegExp; what: string }[] = [
  { re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/, what: 'a private key' },
  { re: /AccountKey=[A-Za-z0-9+/=]{20,}/, what: 'an Azure storage account key' },
  {
    re: /(?:Server|Data Source)=[^'"`\n]*?(?:Password|Pwd)=(?!\$\{)[^;'"`\s]{4,}/i,
    what: 'a SQL connection string with a password'
  },
  { re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, what: 'a GitHub token' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/, what: 'a GitHub token' },
  { re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/, what: 'an API secret key' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/, what: 'a Slack token' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, what: 'an AWS access key' },
  { re: /--client-secret(?:=|\s+)["']?(?![$%{])[^\s"'$%{]{8,}/, what: 'a service principal client secret' },
  { re: /\bRAYFIN_TOKEN\s*[=:]\s*["']?(?![$%{])[A-Za-z0-9._-]{20,}/, what: 'a Rayfin CLI token' }
]

const FAKE_VALUE = /(example|dummy|fake|placeholder|sample|xxxx)/i

function secretSeverity(name: string): AdvisorSeverity | undefined {
  const bare = name.replace(PUBLIC_PREFIX, '')
  if (/PUBLISHABLE/.test(bare)) return undefined
  if (HIGH_SECRET_NAME.test(bare)) return 'high'
  if (MEDIUM_SECRET_NAME.test(bare)) return 'medium'
  return undefined
}

/** A local env file the CLI or the frontend's build reads: the root's, `rayfin/`'s or the frontend package's. */
function isEnvFile(ctx: QuickContext, path: string): boolean {
  return ENV_FILE.test(path) || ENV_NAME.test(relativeTo(path, ctx.layout.frontendRoot) ?? '')
}

/** A file in the frontend package's folder itself, such as its `package.json`. */
function atFrontendRoot(ctx: QuickContext, path: string, name: RegExp): boolean {
  return name.test(relativeTo(path, ctx.layout.frontendRoot) ?? '')
}

function envFiles(ctx: QuickContext, includeTemplates = false): SourceFile[] {
  return ctx.sources((p) => isEnvFile(ctx, p) && (includeTemplates || !isTemplateEnvFile(p)))
}

/** The masked lines around an env entry. */
function envExcerpt(file: SourceFile, line: number): { text: string; start: number } {
  const win = excerptWindow(file.text, line)
  return { text: maskEnvValues(win.text), start: win.start }
}

function committed(ctx: QuickContext, path: string): boolean {
  return ctx.fileInfo(path)?.ignored !== true
}

export const secretRules: QuickRuleImpl[] = [
  {
    id: 'secrets/secret-in-public-env',
    run: (ctx) => {
      const hits: QuickHit[] = []
      const seen = new Set<string>()
      for (const file of envFiles(ctx)) {
        for (const entry of envEntries(file.text)) {
          const severity = PUBLIC_PREFIX.test(entry.key) ? secretSeverity(entry.key) : undefined
          if (!severity || isPlaceholderValue(entry.value)) continue
          seen.add(entry.key)
          hits.push({
            file: file.path,
            line: entry.line,
            label: entry.key,
            severity,
            excerpt: envExcerpt(file, entry.line),
            message: `${code(entry.key)} in ${code(file.path)} looks like a secret, but its prefix exposes it to the browser.`
          })
        }
      }
      for (const src of ctx.frontend) {
        for (const m of matchAll(/\bimport\.meta\.env\.([A-Z][A-Z0-9_]*)/, src.masked)) {
          const name = m[1]
          const severity = PUBLIC_PREFIX.test(name) ? secretSeverity(name) : undefined
          if (!severity || seen.has(name)) continue
          seen.add(name)
          hits.push({
            file: src.path,
            line: lineOf(src, m.index),
            label: name,
            severity,
            message: `${code(src.path)} reads ${code(name)}, which looks like a secret, from browser-visible environment variables.`
          })
        }
      }
      return hits
    }
  },
  {
    id: 'secrets/env-file-not-ignored',
    run: (ctx) => {
      if (!ctx.snapshot.isGitRepo) return 'na'
      return ctx.snapshot.files
        .filter((f) => isEnvFile(ctx, f.path) && !isTemplateEnvFile(f.path) && !f.ignored)
        .map((f) => {
          const src = ctx.file(f.path)
          return {
            file: f.path,
            line: 1,
            label: f.path,
            excerpt: src ? envExcerpt(src, 1) : undefined,
            message: `${code(f.path)} isn't git-ignored, so its values can be committed.`
          }
        })
    }
  },
  {
    id: 'secrets/hardcoded-credential',
    run: (ctx) => {
      const hits: QuickHit[] = []
      const { frontendSrc, dataDir, functionsRoot } = ctx.layout
      const files = ctx.sources(
        (p) =>
          (p.startsWith('src/') ||
            p.startsWith('rayfin/') ||
            p.startsWith('scripts/') ||
            p.startsWith('.github/workflows/') ||
            p === 'package.json' ||
            /^vite\.config\./.test(p) ||
            isUnder(p, frontendSrc) ||
            isUnder(p, dataDir) ||
            isUnder(p, functionsRoot) ||
            atFrontendRoot(ctx, p, /^(package\.json|vite\.config\..+)$/)) &&
          !isEnvFile(ctx, p) &&
          committed(ctx, p)
      )
      for (const src of files) {
        const found = new Set<string>()
        for (const { re, what } of CREDENTIAL_PATTERNS) {
          for (const m of matchAll(re, src.text)) {
            if (FAKE_VALUE.test(m[0]) || found.has(what)) continue
            found.add(what)
            const line = lineOf(src, m.index)
            const win = excerptWindow(src.text, line)
            hits.push({
              file: src.path,
              line,
              label: src.path,
              excerpt: { text: maskSecrets(win.text), start: win.start },
              message: `${code(src.path)} contains ${what}.`
            })
          }
        }
      }
      return hits
    }
  },
  {
    id: 'secrets/redirect-uri-scope',
    run: (ctx) => {
      const uris = ctx.service('auth')?.allowedRedirectUris
      if (!Array.isArray(uris) || !ctx.yml) return []
      const hits: QuickHit[] = []
      for (const raw of uris) {
        if (typeof raw !== 'string') continue
        const uri = raw.trim()
        let problem: string | undefined
        if (uri.includes('*')) problem = 'is a wildcard'
        else {
          try {
            const url = new URL(uri)
            const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
            if (url.protocol === 'http:' && !local) problem = 'uses plain http on a non-local host'
          } catch {
            problem = undefined
          }
        }
        if (!problem) continue
        hits.push({
          file: ctx.yml.path,
          line: lineContaining(ctx.yml.text, uri),
          label: uri,
          message: `The allowed redirect URI ${code(uri)} ${problem}.`
        })
      }
      return hits
    }
  },
  {
    id: 'secrets/publishable-key-mismatch',
    run: (ctx) => {
      const hits: QuickHit[] = []
      for (const file of envFiles(ctx)) {
        for (const entry of envEntries(file.text)) {
          if (!PUBLISHABLE_KEYS.has(entry.key) || isPlaceholderValue(entry.value)) continue
          if (entry.value.startsWith('pk-')) continue
          hits.push({
            file: file.path,
            line: entry.line,
            label: `${file.path} ${entry.key}`,
            excerpt: envExcerpt(file, entry.line),
            message: `${code(entry.key)} in ${code(file.path)} doesn't hold a publishable key (they start with ${code('pk-')}).`
          })
        }
      }
      return hits
    }
  },
  {
    id: 'secrets/deployments-file-tracked',
    run: (ctx) => {
      if (!ctx.snapshot.isGitRepo) return 'na'
      const file = ctx.fileInfo('rayfin/.deployments.json')
      if (!file || file.ignored) return []
      return [
        {
          file: file.path,
          label: file.path,
          message: `${code(file.path)} isn't git-ignored, so your workspace and item IDs can be committed.`
        }
      ]
    }
  },
  {
    id: 'secrets/encryption-fallback-committed',
    run: (ctx) => {
      const hits: QuickHit[] = []
      const files = ctx.sources(
        (p) =>
          (p.startsWith('scripts/') ||
            p.startsWith('.github/workflows/') ||
            p.startsWith('rayfin/') ||
            p === 'package.json' ||
            atFrontendRoot(ctx, p, /^package\.json$/) ||
            isEnvFile(ctx, p)) &&
          committed(ctx, p)
      )
      const re = /RAYFIN_ENCRYPTION_FALLBACK_ENABLED\s*[=:]\s*["']?(?:true|1)\b|--encryption-fallback-enabled\b/
      for (const src of files) {
        const m = re.exec(src.masked)
        if (!m) continue
        hits.push({
          file: src.path,
          line: lineOf(src, m.index),
          label: src.path,
          message: `${code(src.path)} turns on plaintext CLI token caching.`
        })
      }
      return hits
    }
  }
]
