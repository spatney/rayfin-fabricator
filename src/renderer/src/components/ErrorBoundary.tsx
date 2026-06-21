import { Component, type ErrorInfo, type ReactNode } from 'react'
import logo from '../assets/logo.png'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * Catches render-time errors anywhere below it and shows a recoverable fallback
 * instead of a white screen. The error is logged (renderer console + forwarded
 * to the main-process log file is left to global handlers) and the user can
 * reload the window or open the logs folder.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Renderer error:', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="crash">
        <img className="brand-mark" src={logo} alt="" />
        <h1>Something went wrong</h1>
        <p className="crash-sub">
          Rayfin Studio hit an unexpected error. Reloading usually fixes it; your projects and
          chat history are saved.
        </p>
        <pre className="crash-detail">{error.message}</pre>
        <div className="crash-actions">
          <button className="btn btn--primary" onClick={() => window.location.reload()}>
            Reload
          </button>
          <button className="btn btn--ghost" onClick={() => void window.api.openLogs()}>
            Open logs
          </button>
        </div>
      </div>
    )
  }
}
