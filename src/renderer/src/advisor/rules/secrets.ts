import type { AdvisorSeverity } from '@shared/ipc'
import { severityRank } from '@shared/advisor/catalog'
import { isUnder, relativeTo } from '../../model/projectLayout'
import type { QuickContext } from '../context'
import { maskEnvValues, maskSecrets } from '../mask'
import type { QuickHit, QuickRuleImpl, Words } from '../quick'
import { excerptWindow, listSome, say } from '../quick'
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

/** What a credential pattern finds, by its name in the `advisorChecks` catalog. */
type Credential =
  | 'privateKey'
  | 'storageAccountKey'
  | 'sqlPassword'
  | 'githubToken'
  | 'apiSecretKey'
  | 'slackToken'
  | 'awsAccessKey'
  | 'clientSecret'
  | 'rayfinToken'

const CREDENTIAL_PATTERNS: { re: RegExp; what: Credential }[] = [
  { re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/, what: 'privateKey' },
  { re: /AccountKey=[A-Za-z0-9+/=]{20,}/, what: 'storageAccountKey' },
  {
    re: /(?:Server|Data Source)=[^'"`\n]*?(?:Password|Pwd)=(?!\$\{)[^;'"`\s]{4,}/i,
    what: 'sqlPassword'
  },
  { re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, what: 'githubToken' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/, what: 'githubToken' },
  { re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/, what: 'apiSecretKey' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/, what: 'slackToken' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, what: 'awsAccessKey' },
  { re: /--client-secret(?:=|\s+)["']?(?![$%{])[^\s"'$%{]{8,}/, what: 'clientSecret' },
  { re: /\bRAYFIN_TOKEN\s*[=:]\s*["']?(?![$%{])[A-Za-z0-9._-]{20,}/, what: 'rayfinToken' }
]

const FAKE_VALUE = /(example|dummy|fake|placeholder|sample|xxxx)/i

/** The local backend's state folder, which its own `.gitignore` (`*`) keeps out of git. */
const LOCAL_STATE = '.rayfin-local'
const LOCAL_GITIGNORE = `${LOCAL_STATE}/.gitignore`
/** What a part of `.rayfin-local/` holds, by its name in the `advisorChecks` catalog. */
type LocalHolds = 'secrets' | 'keys' | 'database' | 'uploads' | 'ids'
/** What the local backend keeps in `.rayfin-local/`, by name, most sensitive first. */
const LOCAL_STATE_PARTS: { name: string; holds: LocalHolds; severity: AdvisorSeverity }[] = [
  { name: 'secrets.json', holds: 'secrets', severity: 'high' },
  { name: 'keys', holds: 'keys', severity: 'high' },
  { name: 'db.sqlite', holds: 'database', severity: 'high' },
  { name: 'storage', holds: 'uploads', severity: 'medium' },
  { name: 'state.json', holds: 'ids', severity: 'low' }
]
const MAX_LOCAL_PARTS = 6

/** A part of `.rayfin-local/` that git can commit. */
interface LocalPart {
  label: string
  holds?: LocalHolds
  severity: AdvisorSeverity
  /** Its place in {@link LOCAL_STATE_PARTS}; unknown parts come last. */
  rank: number
}

/** Whether a `.gitignore` ignores everything next to it: a `*` line, taking nothing back but itself. */
function ignoresEverything(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
  return (
    lines.some((l) => /^\/?\*\*?$/.test(l)) &&
    !lines.some((l) => l.startsWith('!') && !/^!\/?\.gitignore$/.test(l))
  )
}

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
            ...say((w) =>
              w.t('secrets/secret-in-public-env.inEnvFile', {
                key: code(entry.key),
                file: code(file.path)
              })
            )
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
            ...say((w) =>
              w.t('secrets/secret-in-public-env.inCode', { file: code(src.path), name: code(name) })
            )
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
            ...say((w) => w.t('secrets/env-file-not-ignored.hit', { file: code(f.path) }))
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
              ...say((w) =>
                w.t('secrets/hardcoded-credential.hit', {
                  file: code(src.path),
                  credential: w.t(`secrets/hardcoded-credential.credentials.${what}`)
                })
              )
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
        let problem: 'wildcard' | 'plainHttp' | undefined
        if (uri.includes('*')) problem = 'wildcard'
        else {
          try {
            const url = new URL(uri)
            const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
            if (url.protocol === 'http:' && !local) problem = 'plainHttp'
          } catch {
            problem = undefined
          }
        }
        if (!problem) continue
        hits.push({
          file: ctx.yml.path,
          line: lineContaining(ctx.yml.text, uri),
          label: uri,
          ...say((w) => w.t(`secrets/redirect-uri-scope.${problem}`, { uri: code(uri) }))
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
            ...say((w) =>
              w.t('secrets/publishable-key-mismatch.hit', {
                key: code(entry.key),
                file: code(file.path),
                prefix: code('pk-')
              })
            )
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
          ...say((w) => w.t('secrets/deployments-file-tracked.hit', { file: code(file.path) }))
        }
      ]
    }
  },
  {
    id: 'secrets/local-backend-not-ignored',
    run: (ctx) => {
      if (!ctx.snapshot.isGitRepo) return 'na'
      const files = ctx.snapshot.files.filter((f) => f.path.startsWith(`${LOCAL_STATE}/`))
      if (files.length === 0) return 'na'
      // What git can commit, by the folder's parts: `keys/` rather than each key.
      const parts = new Map<string, LocalPart>()
      for (const f of files) {
        if (f.ignored || f.path === LOCAL_GITIGNORE) continue
        const segments = f.path.slice(LOCAL_STATE.length + 1).split('/')
        const name = segments[0].startsWith('db.sqlite') ? 'db.sqlite' : segments[0]
        if (parts.has(name)) continue
        const known = LOCAL_STATE_PARTS.findIndex((p) => p.name === name)
        const part = LOCAL_STATE_PARTS[known]
        parts.set(name, {
          label: code(`${LOCAL_STATE}/${name}${segments.length > 1 ? '/' : ''}`),
          holds: part?.holds,
          severity: part?.severity ?? 'low',
          rank: known < 0 ? LOCAL_STATE_PARTS.length : known
        })
      }
      if (parts.size === 0) return []
      const exposed = [...parts.values()].sort((a, b) => a.rank - b.rank)
      const holds: (LocalHolds | 'otherFiles' | 'files')[] = exposed.flatMap((p) =>
        p.holds ? [p.holds] : []
      )
      if (exposed.some((p) => !p.holds)) holds.push(holds.length ? 'otherFiles' : 'files')
      const labels = exposed.map((p) => p.label)
      const what = (w: Words): string =>
        w.t('secrets/local-backend-not-ignored.what', {
          holds: w.list(holds.map((h) => w.t(`secrets/local-backend-not-ignored.holds.${h}`))),
          files: listSome(labels, w, MAX_LOCAL_PARTS)
        })
      const gitignore = ctx.fileInfo(LOCAL_GITIGNORE)
      const text = ctx.snapshot.contents[LOCAL_GITIGNORE]
      const changed = text !== undefined && !ignoresEverything(text)
      const said = say((w) => {
        const values = { gitignore: code(LOCAL_GITIGNORE), what: what(w) }
        if (!gitignore) return w.t('secrets/local-backend-not-ignored.missing', values)
        if (changed) return w.t('secrets/local-backend-not-ignored.changed', values)
        if (text !== undefined) {
          return w.t('secrets/local-backend-not-ignored.tracked', {
            ...values,
            folder: code(`${LOCAL_STATE}/`)
          })
        }
        return w.t('secrets/local-backend-not-ignored.unknown', values)
      })
      return [
        {
          file: changed ? LOCAL_GITIGNORE : undefined,
          line: changed ? 1 : undefined,
          label: `${LOCAL_STATE}/`,
          severity: exposed.reduce<AdvisorSeverity>(
            (worst, p) => (severityRank(p.severity) < severityRank(worst) ? p.severity : worst),
            'low'
          ),
          ...said
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
          ...say((w) => w.t('secrets/encryption-fallback-committed.hit', { file: code(src.path) }))
        })
      }
      return hits
    }
  }
]
