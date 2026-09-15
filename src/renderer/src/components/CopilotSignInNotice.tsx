import { useEffect, useRef, useState } from 'react'
import { getCopilotHost, signInToCopilot } from '../copilotAuth'
import CopilotHostInput from './CopilotHostInput'

interface Props {
  detail?: string
  host?: string
  disabled?: boolean
  onSignedIn: () => Promise<void> | void
}

export default function CopilotSignInNotice({ detail, host, disabled, onSignedIn }: Props): JSX.Element {
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
        setError(result.error ?? 'Copilot sign-in did not complete. Please try again.')
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
      <strong>Copilot needs your attention</strong>
      <div>{error ?? detail ?? 'Sign in to GitHub Copilot here, then retry your message.'}</div>
      <CopilotHostInput value={copilotHost} disabled={busy || disabled} onChange={setCopilotHost} />
      <button className="btn btn--primary btn--sm" disabled={busy || disabled} onClick={() => void signIn()}>
        {busy ? 'Signing in to Copilot...' : 'Sign in to Copilot'}
      </button>
      {busy && <div>Complete sign-in in your browser, or follow the device-code instructions below.</div>}
      {log && <pre className="log-console log-console--sm">{log}</pre>}
    </div>
  )
}
