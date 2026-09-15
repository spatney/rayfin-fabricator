import { useId } from 'react'

interface Props {
  value: string
  disabled?: boolean
  onChange: (host: string) => void
}

export default function CopilotHostInput({ value, disabled, onChange }: Props): JSX.Element {
  const id = useId()
  return (
    <div className="field copilot-host-field">
      <label className="field-label" htmlFor={id}>GitHub host</label>
      <input
        id={id}
        className="field-input"
        type="text"
        autoCapitalize="none"
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder="github.com or company.ghe.com"
        disabled={disabled}
        aria-describedby={`${id}-hint`}
        onChange={(event) => onChange(event.target.value)}
      />
      <span id={`${id}-hint`} className="field-hint">
        Use github.com or your Enterprise Cloud host (company.ghe.com). An https:// URL is also accepted.
      </span>
    </div>
  )
}
