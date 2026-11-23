import { useEffect, useRef, useState, type JSX } from 'react'
import { getCopilotHost, signInToCopilot } from '../copilotAuth'
import CopilotHostInput from './CopilotHostInput'
import { openDocs } from '../docsLinks'
import { useTranslation } from '../i18n'

interface Props {
  detail?: string
  host?: string
  disabled?: boolean
  onSignedIn: () => Promise<void> | void
}

export default function CopilotSignInNotice({ detail, host, disabled, onSignedIn }: Props): JSX.Element {
  const { t } = useTranslation('accounts')
  const [copilotHost, setCopilotHost] = useState(() => host ?? getCopilotHost())
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState('')
  const [error, setError] = useState<string | null>(null)
  const running = useRef(false)
  const unsubscribe = useRef<(() => void) | null>(null)

  useEffect(() => () => unsubscribe.current?.(), [])

  async function signIn(): Promise<void> {
    if (running.current) return
    running.current = true
    setBusy(true)
    setError(null)
    setLog('')
    try {
      unsubscribe.current = window.api.onProcLog((event) => {
        if (event.channel === 'login:copilot') {
          setLog((previous) => (previous + event.data).slice(-16000))
        }
      })
      const result = await signInToCopilot(copilotHost)
      if (!result.ok) {
        setError(result.error ?? t('copilotSignInFailed'))
        return
      }
      await onSignedIn()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      unsubscribe.current?.()
      unsubscribe.current = null
      running.current = false
      setBusy(false)
    }
  }

  return (
    <div className="alert alert--error copilot-auth-notice" role="alert">
      <strong>{t('copilotNotice.title')}</strong>
      <div>{error ?? detail ?? t('copilotNotice.signInHere')}</div>
      <CopilotHostInput value={copilotHost} disabled={busy || disabled} onChange={setCopilotHost} />
      <button className="btn btn--primary btn--sm" disabled={busy || disabled} onClick={() => void signIn()}>
        {busy ? t('copilotNotice.signingIn') : t('copilotNotice.signIn')}
      </button>
      <button className="btn btn--sm btn--link" onClick={() => openDocs('copilotSignIn')}>
        {t('copilotNotice.help')}
      </button>
      {busy && <div>{t('copilotNotice.inBrowser')}</div>}
      {log && <pre className="log-console log-console--sm">{log}</pre>}
    </div>
  )
}
