import type { Language, LanguagePreference } from '@shared/ipc'

/**
 * The languages Fabricator comes in: English, the source, then its
 * translations. Each has a folder of catalogs in `locales/`, and the core
 * lists the same ones (`i18n::LANGUAGES` in Rust).
 */
export const LANGUAGES: readonly Language[] = ['en', 'es', 'de', 'ja']

/** Each language's name in itself, as Settings lists it. */
export const LANGUAGE_NAMES: Readonly<Record<Language, string>> = {
  en: 'English',
  es: 'Español',
  de: 'Deutsch',
  ja: '日本語'
}

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value)
}

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === 'system' || isLanguage(value)
}

/**
 * The first of `tags` (BCP 47, most preferred first) in a language Fabricator
 * comes in, or undefined for none. A tag matches by its language alone, so
 * es-MX and de-CH match es and de.
 */
export function matchLanguage(tags: readonly string[]): Language | undefined {
  for (const tag of tags) {
    const language = tag.trim().toLowerCase().split(/[-_]/)[0]
    if (isLanguage(language)) return language
  }
  return undefined
}
