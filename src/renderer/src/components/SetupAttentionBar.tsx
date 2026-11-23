import { listText, type SetupAttention } from '../startup'
import { useTranslation } from '../i18n'
import { Codicon } from './icons'

import type { JSX } from 'react'

interface Props {
  attention: SetupAttention
  onManageAccounts: () => void
  onReviewSetup: () => void
  onDismiss: () => void
}

/**
 * A slim bar under the app bar for what the launch's background check found —
 * the things setup would have caught, like a signed-out account or a missing
 * tool. It never blocks the app; each problem links to where it's fixed.
 */
export default function SetupAttentionBar({
  attention,
  onManageAccounts,
  onReviewSetup,
  onDismiss
}: Props): JSX.Element {
  const { t } = useTranslation('app')
  const { tools, signIns, error } = attention
  const parts: string[] = []
  if (signIns.length > 0) parts.push(t('attention.notSignedIn', { names: listText(signIns) }))
  if (tools.length > 0) {
    parts.push(t('attention.toolsMissing', { count: tools.length, tools: listText(tools) }))
  }
  if (error) parts.push(error)
  return (
    <div className="attention-bar" role="status">
      <Codicon name="warning" className="attention-bar-ico" />
      <span className="attention-bar-text">{parts.join(' ')}</span>
      <span className="attention-bar-actions">
        {signIns.length > 0 && (
          <button type="button" className="btn btn--xs" onClick={onManageAccounts}>
            {t('attention.manageAccounts')}
          </button>
        )}
        {(tools.length > 0 || error) && (
          <button type="button" className="btn btn--xs" onClick={onReviewSetup}>
            {t('attention.reviewSetup')}
          </button>
        )}
        <button
          type="button"
          className="btn btn--xs btn--ghost attention-bar-close"
          aria-label={t('actions.dismiss')}
          title={t('actions.dismiss')}
          onClick={onDismiss}
        >
          <Codicon name="close" />
        </button>
      </span>
    </div>
  )
}
