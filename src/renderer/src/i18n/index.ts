// Fabricator's interface in the user's language, with i18next. Components
// translate with `useTranslation(namespace)`; other code with `translator`.
// English is bundled; a translation loads the first time it's shown.
import i18next, { type TFunction } from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { Language, LanguagePreference } from '@shared/ipc'
import { isLanguage, LANGUAGES, matchLanguage } from './languages'
import { en, NAMESPACES, type Namespace } from './resources'

export { Trans, useTranslation } from 'react-i18next'
export {
  isLanguage,
  isLanguagePreference,
  LANGUAGE_NAMES,
  LANGUAGES,
  matchLanguage
} from './languages'
export { currentLanguage, formatList, formatLocale } from './format'
export type { Namespace } from './resources'

/** The language last shown, so the next launch starts in it before settings load. */
const LANGUAGE_KEY = 'fabricator.language'

type Catalog = { [key: string]: unknown }

// Each translation's catalogs, keyed by file name: './locales/de.ts'.
const translations = import.meta.glob<Record<string, Catalog>>('./locales/*.ts', {
  import: 'default'
})

void i18next.use(initReactI18next).init({
  resources: { en },
  lng: 'en',
  fallbackLng: 'en',
  supportedLngs: [...LANGUAGES],
  load: 'currentOnly',
  ns: [...NAMESPACES],
  defaultNS: 'common',
  fallbackNS: 'common',
  initAsync: false,
  // React escapes what it renders.
  interpolation: { escapeValue: false },
  // A translation left empty shows the English.
  returnEmptyString: false,
  react: { useSuspense: false }
})

export const i18n = i18next

/**
 * A `t` for one namespace, for code outside components. It translates into
 * the language shown when it's called, so call it when the text is needed,
 * never when the module loads.
 */
export function translator<N extends Namespace>(ns: N): TFunction<N> {
  return i18next.getFixedT(null, ns)
}

/** For each translation shown so far: its text, and the English it translates. */
const originals = new Map<string, Map<string, string>>()

function originalsOf(language: string): Map<string, string> {
  const cached = originals.get(language)
  if (cached) return cached
  const index = new Map<string, string>()
  const walk = (shown: unknown, source: unknown): void => {
    if (!shown || typeof shown !== 'object' || !source || typeof source !== 'object') return
    for (const [key, value] of Object.entries(shown as Catalog)) {
      // A plural form English doesn't have (Spanish's `_many`) translates its `_other`.
      const original =
        (source as Catalog)[key] ??
        (source as Catalog)[key.replace(/_(zero|one|two|few|many)$/, '_other')]
      if (typeof value !== 'string') walk(value, original)
      else if (typeof original === 'string' && !index.has(value)) index.set(value, original)
    }
  }
  for (const ns of NAMESPACES) walk(i18next.getResourceBundle(language, ns), en[ns])
  originals.set(language, index)
  return index
}

/**
 * The English of a text shown in the current language, for code that reads
 * English, like the grouping of what a toast said. It knows a catalog's text as
 * written, before placeholders are filled; other text comes back as it is.
 */
export function inEnglish(text: string): string {
  const language = i18next.language
  if (!text || !language || language === 'en') return text
  return originalsOf(language).get(text) ?? text
}

/**
 * A catalog with every plural form `language` has: a form the translation
 * leaves out reads as its `other` form. Spanish has a form for a million, say,
 * that i18next would otherwise show in English.
 */
export function withAllPluralForms(language: string, catalog: Catalog): Catalog {
  const forms = new Intl.PluralRules(language).resolvedOptions().pluralCategories
  const fill = (node: Catalog): Catalog => {
    const out: Catalog = {}
    for (const [key, value] of Object.entries(node)) {
      out[key] = value !== null && typeof value === 'object' ? fill(value as Catalog) : value
    }
    for (const [key, value] of Object.entries(node)) {
      if (!key.endsWith('_other') || typeof value !== 'string') continue
      const base = key.slice(0, -'_other'.length)
      for (const form of forms) if (!(`${base}_${form}` in out)) out[`${base}_${form}`] = value
    }
    return out
  }
  return fill(catalog)
}

const loading = new Map<Language, Promise<void>>()

/** Add a translation's catalogs, the first time it's shown. */
function load(language: Language): Promise<void> {
  if (language === 'en') return Promise.resolve()
  let pending = loading.get(language)
  if (!pending) {
    const catalogs = translations[`./locales/${language}.ts`]
    if (!catalogs) return Promise.reject(new Error(`No catalogs for ${language}`))
    pending = catalogs().then((files) => {
      for (const [file, catalog] of Object.entries(files)) {
        const ns = /([^/]+)\.json$/.exec(file)?.[1]
        if (ns) i18next.addResourceBundle(language, ns, withAllPluralForms(language, catalog))
      }
    })
    // Try again next time rather than keep a failure.
    pending.catch(() => loading.delete(language))
    loading.set(language, pending)
  }
  return pending
}

function remember(language: Language): void {
  try {
    localStorage.setItem(LANGUAGE_KEY, language)
  } catch {
    /* best-effort: only the first frame of the next launch depends on it */
  }
}

function recall(): string | null {
  try {
    return localStorage.getItem(LANGUAGE_KEY)
  } catch {
    return null
  }
}

let shown = 0

/** Show the interface in a language once its catalogs load. When calls overlap, the last wins. */
async function show(next: Language | Promise<Language>): Promise<void> {
  const mine = ++shown
  let language = await next
  try {
    await load(language)
  } catch (err) {
    console.warn(`Couldn't load the ${language} translation`, err)
    language = 'en'
  }
  if (mine !== shown) return
  if (i18next.language !== language) await i18next.changeLanguage(language)
  document.documentElement.lang = language
  remember(language)
}

/** Show the interface in `language`. */
export function setLanguage(language: Language): Promise<void> {
  return show(language)
}

/**
 * The language the computer's settings ask for, of the ones Fabricator comes
 * in, and English when it's none of them. The core reads the computer's list
 * of languages; the web view's own is the fallback.
 */
export async function systemLanguage(): Promise<Language> {
  try {
    const language = await window.api.settings.systemLanguage()
    if (isLanguage(language)) return language
  } catch {
    /* ask the web view instead */
  }
  const tags = navigator.languages?.length ? navigator.languages : [navigator.language]
  return matchLanguage(tags) ?? 'en'
}

/** The language a preference shows: the one chosen, or the computer's for 'system'. */
export function resolveLanguage(preference: LanguagePreference | undefined): Promise<Language> {
  return isLanguage(preference) ? Promise.resolve(preference) : systemLanguage()
}

/** Show the interface in the language a preference asks for. */
export function applyLanguagePreference(preference: LanguagePreference | undefined): Promise<void> {
  return show(resolveLanguage(preference))
}

function within<T>(promise: Promise<T>, ms: number, otherwise: T): Promise<T> {
  return Promise.race([
    promise.catch(() => otherwise),
    new Promise<T>((resolve) => window.setTimeout(() => resolve(otherwise), ms))
  ])
}

/**
 * Before the first render: start in the language last shown, else the one the
 * settings ask for, so the first screen is already in it.
 */
export async function startLanguage(): Promise<void> {
  const last = recall()
  if (isLanguage(last)) return setLanguage(last)
  const preference = await within(
    window.api.settings.get().then((settings) => settings?.language),
    2000,
    undefined
  )
  return show(within(resolveLanguage(preference), 2000, 'en'))
}

// A change of language in one window (Settings is in the main one) reaches the
// others, such as an installed app's.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (
      event.key === LANGUAGE_KEY &&
      isLanguage(event.newValue) &&
      event.newValue !== i18next.language
    ) {
      void setLanguage(event.newValue)
    }
  })
}
