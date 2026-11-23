import { afterEach, describe, expect, it, vi } from 'vitest'
import { CATEGORIES, RULES } from '@shared/advisor/catalog'
import {
  formatList,
  formatLocale,
  i18n,
  LANGUAGES,
  matchLanguage,
  resolveLanguage,
  setLanguage,
  startLanguage,
  translator,
  withAllPluralForms
} from '.'
import { NAMESPACES } from './resources'

type Catalog = { [key: string]: unknown }

const files = import.meta.glob<Catalog>('./locales/*/*.json', { eager: true, import: 'default' })
const bundles = Object.keys(import.meta.glob('./locales/*.ts'))

/** Each language's catalogs, by namespace. */
const catalogs: Record<string, Record<string, Catalog>> = {}
for (const [file, catalog] of Object.entries(files)) {
  const [, language, ns] = /^\.\/locales\/([^/]+)\/([^/]+)\.json$/.exec(file) ?? []
  ;(catalogs[language] ??= {})[ns] = catalog
}

/** The Advisor's rules: their English is rules.json's (see advisor/ruleText.ts). */
const ADVISOR_RULES: Catalog = {
  rules: Object.fromEntries(
    RULES.map((r) => [r.id, { title: r.title, summary: r.summary, why: r.why, fix: r.fix }])
  ),
  categories: Object.fromEntries(
    CATEGORIES.map((c) => [c.id, { title: c.title, description: c.description }])
  )
}

/** A namespace's English. */
function english(ns: string): Catalog {
  return ns === 'advisorRules' ? ADVISOR_RULES : catalogs.en[ns]
}

function flatten(node: Catalog, prefix = '', out: Record<string, unknown> = {}) {
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value as Catalog, path, out)
    } else {
      out[path] = value
    }
  }
  return out
}

const FORM = /_(zero|one|two|few|many|other)$/

/** A catalog's keys by base: a plural's forms under its base, any other key under itself (form null). */
function byBase(catalog: Catalog): Map<string, Map<string | null, string>> {
  const bases = new Map<string, Map<string | null, string>>()
  for (const [key, value] of Object.entries(flatten(catalog))) {
    const form = FORM.exec(key)
    const base = form ? key.slice(0, form.index) : key
    if (!bases.has(base)) bases.set(base, new Map())
    bases.get(base)?.set(form ? form[1] : null, String(value))
  }
  return bases
}

/** The `{{placeholders}}` in texts, without `count`, which a plural's forms may leave out. */
function placeholders(texts: Iterable<string>, withCount: boolean): string[] {
  const names = new Set<string>()
  for (const text of texts) {
    for (const [, name] of text.matchAll(/\{\{\s*([\w.]+)[^}]*\}\}/g)) {
      if (withCount || name !== 'count') names.add(name)
    }
  }
  return [...names].sort()
}

/** The `<tags>` Trans fills in with components. */
function tags(texts: Iterable<string>): string[] {
  const found = new Set<string>()
  for (const text of texts)
    for (const [tag] of text.matchAll(/<\/?[A-Za-z][\w-]*\s*\/?>/g)) found.add(tag)
  return [...found].sort()
}

/** The `code` in texts, which a translation keeps as it is. */
function code(texts: Iterable<string>): string[] {
  const found = new Set<string>()
  for (const text of texts) for (const [span] of text.matchAll(/`[^`]+`/g)) found.add(span)
  return [...found].sort()
}

describe('catalogs', () => {
  it('come in every language, with the same namespaces', () => {
    expect(Object.keys(catalogs).sort()).toEqual([...LANGUAGES].sort())
    for (const language of LANGUAGES) {
      expect(Object.keys(catalogs[language]).sort(), language).toEqual([...NAMESPACES].sort())
    }
    expect(bundles.sort()).toEqual(
      LANGUAGES.filter((l) => l !== 'en')
        .map((l) => `./locales/${l}.ts`)
        .sort()
    )
  })

  it('hold only text', () => {
    for (const language of LANGUAGES) {
      for (const [ns, catalog] of Object.entries(catalogs[language])) {
        for (const [key, value] of Object.entries(flatten(catalog))) {
          expect(typeof value === 'string' && value.trim() !== '', `${language} ${ns}:${key}`).toBe(
            true
          )
        }
      }
    }
  })

  for (const language of LANGUAGES.filter((l) => l !== 'en')) {
    describe(language, () => {
      const forms = new Set<string>(
        new Intl.PluralRules(language).resolvedOptions().pluralCategories
      )

      it.each([...NAMESPACES])('%s has the English keys, placeholders, tags and code', (ns) => {
        const source = byBase(english(ns))
        const translated = byBase(catalogs[language][ns])
        expect([...translated.keys()].sort()).toEqual([...source.keys()].sort())

        for (const [base, texts] of source) {
          const target = translated.get(base)
          if (!target) continue
          const where = `${language} ${ns}:${base}`
          const plural = !texts.has(null)
          expect(!target.has(null), `${where} is ${plural ? '' : 'not '}a plural`).toBe(plural)
          if (plural) {
            expect(target.has('other'), `${where}_other`).toBe(true)
            if (forms.has('one')) expect(target.has('one'), `${where}_one`).toBe(true)
            if (texts.has('zero')) expect(target.has('zero'), `${where}_zero`).toBe(true)
            for (const form of target.keys()) {
              expect(form === 'zero' || forms.has(String(form)), `${where}_${form}`).toBe(true)
            }
          }
          expect(placeholders(target.values(), !plural), `${where} placeholders`).toEqual(
            placeholders(texts.values(), !plural)
          )
          expect(tags(target.values()), `${where} tags`).toEqual(tags(texts.values()))
          expect(code(target.values()), `${where} code`).toEqual(code(texts.values()))
        }
      })
    })
  }

  it('give English every plural form it needs', () => {
    for (const ns of NAMESPACES) {
      for (const [base, forms] of byBase(english(ns))) {
        if (forms.has(null)) continue
        expect(forms.has('one') && forms.has('other'), `en ${ns}:${base}`).toBe(true)
      }
    }
  })
})

describe('withAllPluralForms', () => {
  it('reads a plural form a translation leaves out as its other form', () => {
    expect(
      withAllPluralForms('es', {
        title: 'Archivos',
        files: { count_one: '{{count}} archivo', count_other: '{{count}} archivos' }
      })
    ).toEqual({
      title: 'Archivos',
      files: {
        count_one: '{{count}} archivo',
        count_other: '{{count}} archivos',
        count_many: '{{count}} archivos'
      }
    })
  })

  it('keeps the forms a translation has', () => {
    const catalog = { n_one: 'one', n_many: 'many', n_other: 'other' }
    expect(withAllPluralForms('es', catalog)).toEqual(catalog)
  })
})

describe('matchLanguage', () => {
  it.each([
    [['es-MX'], 'es'],
    [['fr-FR', 'de-CH', 'ja'], 'de'],
    [['ja_JP'], 'ja'],
    [['EN-gb'], 'en'],
    [['fr', 'it'], undefined],
    [[], undefined]
  ])('matches %j to %s', (tags, language) => {
    expect(matchLanguage(tags)).toBe(language)
  })
})

describe('switching language', () => {
  afterEach(async () => {
    await setLanguage('en')
    localStorage.clear()
    delete (window as unknown as { api?: unknown }).api
  })

  function installApi(api: {
    systemLanguage?: () => Promise<string>
    get?: () => Promise<unknown>
  }) {
    ;(window as unknown as { api: unknown }).api = { settings: api }
  }

  it('translates text a translator gives once the language is shown', async () => {
    const t = translator('settings')
    expect(t('title')).toBe('Settings')
    await setLanguage('de')
    expect(t('title')).toBe('Einstellungen')
    expect(t('actions.cancel')).toBe('Abbrechen')
    expect(document.documentElement.lang).toBe('de')
    expect(localStorage.getItem('fabricator.language')).toBe('de')
  })

  it('shows the language asked for last when switches overlap', async () => {
    await Promise.all([setLanguage('ja'), setLanguage('es')])
    expect(i18n.language).toBe('es')
  })

  it('formats in the computer’s region of the interface’s language', async () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-GB', 'de-AT'])
    expect(formatLocale()).toBe('en-GB')
    await setLanguage('de')
    expect(formatLocale()).toBe('de-AT')
    await setLanguage('ja')
    expect(formatLocale()).toBe('ja')
  })

  it('lists in the interface’s language, without a comma before English’s last “and”', async () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-US'])
    expect(formatList(['A', 'B', 'C'])).toBe('A, B and C')
    expect(formatList(['A', 'B', 'C'], 'disjunction')).toBe('A, B or C')
    await setLanguage('de')
    expect(formatList(['A', 'B', 'C'])).toBe('A, B und C')
  })

  it('resolves System to the core’s language, else the web view’s, else English', async () => {
    expect(await resolveLanguage('es')).toBe('es')
    installApi({ systemLanguage: () => Promise.resolve('ja') })
    expect(await resolveLanguage('system')).toBe('ja')
    installApi({ systemLanguage: () => Promise.reject(new Error('no core')) })
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['fr-FR', 'es-ES'])
    expect(await resolveLanguage(undefined)).toBe('es')
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['fr-FR'])
    expect(await resolveLanguage('system')).toBe('en')
  })

  it('starts in the language last shown, before settings load', async () => {
    const get = vi.fn(() => Promise.resolve({ theme: 'system', language: 'es' }))
    installApi({ get })
    localStorage.setItem('fabricator.language', 'ja')
    await startLanguage()
    expect(i18n.language).toBe('ja')
    expect(get).not.toHaveBeenCalled()
  })

  it('starts in the language settings ask for the first time', async () => {
    installApi({ get: () => Promise.resolve({ theme: 'system', language: 'de' }) })
    await startLanguage()
    expect(i18n.language).toBe('de')
  })
})
