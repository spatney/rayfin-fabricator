import i18next from 'i18next'
import type { Language } from '@shared/ipc'
import { isLanguage } from './languages'

/** The language the interface is in. */
export function currentLanguage(): Language {
  return isLanguage(i18next.language) ? i18next.language : 'en'
}

/**
 * The locale to format dates, times and numbers in, for `toLocaleString` and
 * `Intl`: the computer's own when it's in the interface's language (keeping
 * its region, say en-GB or de-AT), else the interface's language.
 */
export function formatLocale(): string {
  const language = currentLanguage()
  const own =
    typeof navigator === 'undefined'
      ? []
      : navigator.languages?.length
        ? navigator.languages
        : [navigator.language]
  return (
    own.find((tag) => typeof tag === 'string' && tag.toLowerCase().split(/[-_]/)[0] === language) ??
    language
  )
}

/**
 * `A`, `A and B`, `A, B and C` (or `A, B or C`) in the interface's language.
 * Fabricator's English has no comma before the last "and".
 */
export function formatList(
  items: readonly string[],
  type: 'conjunction' | 'disjunction' = 'conjunction'
): string {
  const locale = currentLanguage() === 'en' ? 'en-GB' : formatLocale()
  // Safari has Intl.ListFormat from 14.1 (macOS 11.3).
  if (typeof Intl.ListFormat !== 'function') return items.join(', ')
  return new Intl.ListFormat(locale, { type }).format(items)
}
