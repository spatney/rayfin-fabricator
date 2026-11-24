import type { Language, LanguagePreference } from '@shared/ipc'

/**
 * The languages Fabricator comes in: English, the source, then its
 * translations. Each has a folder of catalogs in `locales/`, and the core
 * lists the same ones (`i18n::LANGUAGES` in Rust).
 */
export const LANGUAGES: readonly Language[] = ['en', 'es', 'de', 'ja', 'pt-BR']

/** Each language's name in itself, as Settings lists it. */
export const LANGUAGE_NAMES: Readonly<Record<Language, string>> = {
  en: 'English',
  es: 'Español',
  de: 'Deutsch',
  ja: '日本語',
  'pt-BR': 'Português (Brasil)'
}

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value)
}

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === 'system' || isLanguage(value)
}

/** A BCP 47 tag's language subtag, lowercased: `pt` for `pt-BR` or `pt_PT`. */
export function primaryLanguage(tag: string): string {
  return tag.trim().toLowerCase().split(/[-_]/)[0]
}

/**
 * The first of `tags` (BCP 47, most preferred first) in a language Fabricator
 * comes in, or undefined for none. A tag matches by its language alone, so
 * es-MX, de-CH and pt-PT match es, de and pt-BR.
 */
export function matchLanguage(tags: readonly string[]): Language | undefined {
  for (const tag of tags) {
    const language = LANGUAGES.find((l) => primaryLanguage(l) === primaryLanguage(tag))
    if (language) return language
  }
  return undefined
}
