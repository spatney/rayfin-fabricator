import { useId, type JSX } from 'react'
import { useTranslation } from '../i18n'

interface Props {
  value: string
  disabled?: boolean
  onChange: (host: string) => void
}

export default function CopilotHostInput({ value, disabled, onChange }: Props): JSX.Element {
  const { t } = useTranslation('accounts')
  const id = useId()
  return (
    <div className="field copilot-host-field">
      <label className="field-label" htmlFor={id}>{t('host.label')}</label>
      <input
        id={id}
        className="field-input"
        type="text"
        autoCapitalize="none"
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={t('host.placeholder')}
        disabled={disabled}
        aria-describedby={`${id}-hint`}
        onChange={(event) => onChange(event.target.value)}
      />
      <span id={`${id}-hint`} className="field-hint">
        {t('host.hint')}
      </span>
    </div>
  )
}
