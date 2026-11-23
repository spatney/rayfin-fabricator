import 'i18next'
import type { en } from './resources'

// Type-checks every key against the English catalogs: `t('chat:send')` fails
// to compile when chat.json has no `send`. Keys missing from a namespace fall
// back to `common`.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common'
    fallbackNS: 'common'
    resources: typeof en
  }
}
