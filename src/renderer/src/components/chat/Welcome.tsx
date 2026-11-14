import type { Suggestion } from '@shared/ipc'
import { Trans, useTranslation } from '../../i18n'
import { FabricatorMark } from '../FabricatorMark'
import { Codicon } from '../icons'

import type { JSX } from 'react'

/** The empty chat: a warm hello, idea cards grounded in the app, and a few tips. */
export function Welcome({
  projectName,
  suggestions,
  tailoring,
  generated,
  onPick,
  onRefresh
}: {
  projectName: string
  suggestions: Suggestion[]
  /** Copilot is still generating ideas from the app's code. */
  tailoring: boolean
  /** The ideas shown came from Copilot (and can be refreshed). */
  generated: boolean
  onPick: (text: string) => void
  onRefresh: () => void
}): JSX.Element {
  const { t } = useTranslation('chat')
  return (
    <div className="chat-welcome">
      <div className="chat-welcome-mark" aria-hidden="true">
        <FabricatorMark />
      </div>
      <h2 className="chat-welcome-title">{t('welcome.title', { name: projectName })}</h2>
      <p className="chat-welcome-sub">{t('welcome.sub')}</p>
      <div className="chat-ideas">
        <div className="chat-ideas-head">
          <span className={`chat-ideas-label${tailoring ? ' shimmer-text' : ''}`}>
            {tailoring ? t('welcome.tailoring') : t('welcome.ideas')}
          </span>
          {generated && !tailoring && (
            <button
              type="button"
              className="chat-ideas-refresh"
              onClick={onRefresh}
              title={t('welcome.refreshTitle')}
            >
              <Codicon name="refresh" /> {t('actions.refresh')}
            </button>
          )}
        </div>
        <div className="chat-suggestions" aria-busy={tailoring}>
          {suggestions.map((s) => (
            <button
              key={s.text}
              type="button"
              className="chat-suggestion"
              onClick={() => onPick(s.text)}
            >
              <span className="chat-suggestion-icon" aria-hidden="true">
                {s.icon}
              </span>
              <span className="chat-suggestion-text">{s.text}</span>
              <Codicon name="arrow-right" className="chat-suggestion-arrow" />
            </button>
          ))}
        </div>
      </div>
      <ul className="chat-welcome-tips" aria-label={t('welcome.tips')}>
        <li>
          <Codicon name="device-camera" /> {t('welcome.tipScreenshot')}
        </li>
        <li>
          <Codicon name="mention" />{' '}
          <Trans t={t} i18nKey="welcome.tipMention" components={{ kbd: <kbd /> }} />
        </li>
        <li>
          <Codicon name="add" />{' '}
          <Trans t={t} i18nKey="welcome.tipData" components={{ kbd: <kbd /> }} />
        </li>
      </ul>
    </div>
  )
}
