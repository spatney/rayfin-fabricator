import { useCallback, useEffect, useState } from 'react'
import type { AuthStatus, DoctorReport } from '@shared/ipc'
import SetupScreen from './screens/SetupScreen'
import Workbench from './screens/Workbench'
import logo from './assets/logo.png'

type Phase = 'loading' | 'setup' | 'ready'

function App(): JSX.Element {
  const [phase, setPhase] = useState<Phase>('loading')
  const [doctor, setDoctor] = useState<DoctorReport | null>(null)
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    setRefreshing(true)
    try {
      const [d, a] = await Promise.all([window.api.doctor.check(), window.api.auth.status()])
      setDoctor(d)
      setAuth(a)
      const ready = d.ready && a.copilot.signedIn && a.rayfin.signedIn
      setPhase(ready ? 'ready' : 'setup')
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (phase === 'loading') {
    return (
      <div className="splash">
        <img className="brand-mark" src={logo} alt="Rayfin Studio" />
        <span>Starting Rayfin Studio…</span>
      </div>
    )
  }

  if (phase === 'ready' && auth) {
    return <Workbench auth={auth} onSignOut={refresh} />
  }

  return (
    <SetupScreen doctor={doctor} auth={auth} refreshing={refreshing} onRefresh={refresh} />
  )
}

export default App
