import type { JSX } from 'react'
import { useTranslation } from '../../i18n'
import { Codicon } from '../icons'
import { PAGE_SIZE } from './localData'

/** The Data explorer's empty state: an icon, what's missing, and how it fills. */
export function Empty({
  icon,
  title,
  sub
}: {
  icon: string
  title: string
  sub: string
}): JSX.Element {
  return (
    <div className="model-empty model-empty--cta">
      <span className="bp-data-empty-ico">
        <Codicon name={icon} />
      </span>
      <div className="model-empty-title">{title}</div>
      <p className="model-empty-sub">{sub}</p>
    </div>
  )
}

export function Problem({
  title,
  error,
  onRetry,
  extra
}: {
  title: string
  error: { message: string; hint?: string | null }
  onRetry?: () => void
  /** Another way out, beside Retry. */
  extra?: { label: string; onClick: () => void }
}): JSX.Element {
  const { t } = useTranslation('data')
  return (
    <div className="model-empty model-empty--cta" role="alert">
      <div className="model-empty-title">{title}</div>
      <p className="model-empty-sub">{error.message}</p>
      {error.hint && <p className="model-empty-sub bp-data-hint">{error.hint}</p>}
      {(onRetry || extra) && (
        <div className="bp-data-actions">
          {onRetry && (
            <button type="button" className="btn btn--sm" onClick={onRetry}>
              <Codicon name="refresh" />
              {t('actions.retry')}
            </button>
          )}
          {extra && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={extra.onClick}>
              {extra.label}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** Which of `total` rows (or files) show, and Previous and Next when there are more than a page. */
export function Pager({
  offset,
  shown,
  total,
  onOffset
}: {
  offset: number
  shown: number
  total: number
  onOffset: (offset: number) => void
}): JSX.Element {
  const { t } = useTranslation('data')
  return (
    <div className="bp-data-pager">
      <span>{t('pager.range', { first: offset + 1, last: offset + shown, total })}</span>
      {total > PAGE_SIZE && (
        <>
          <div className="model-toolbar-spacer" />
          <button
            type="button"
            className="model-tool-btn"
            onClick={() => onOffset(Math.max(0, offset - PAGE_SIZE))}
            disabled={offset === 0}
            aria-label={t('pager.previousPage')}
          >
            <Codicon name="chevron-left" />
            {t('pager.previous')}
          </button>
          <button
            type="button"
            className="model-tool-btn"
            onClick={() => onOffset(offset + PAGE_SIZE)}
            disabled={offset + PAGE_SIZE >= total}
            aria-label={t('pager.nextPage')}
          >
            {t('actions.next')}
            <Codicon name="chevron-right" />
          </button>
        </>
      )}
    </div>
  )
}
