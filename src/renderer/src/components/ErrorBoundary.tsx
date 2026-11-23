import { Component, type ErrorInfo, type ReactNode } from 'react'
import { FabricatorMark } from './FabricatorMark'
import { reportError } from '../errorReport'
import { translator } from '../i18n'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * Catches render-time errors anywhere below it and shows a recoverable fallback
 * instead of a white screen. The error is logged to the renderer console and
 * recorded in the error journal, so the Help assistant can explain the crash
 * afterwards; the user can reload the window or open the logs folder.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Renderer error:', error, info.componentStack)
    reportError({
      surface: 'boundary',
      area: 'ui',
      message: error.message || 'The interface crashed.',
      detail: [error.stack, info.componentStack].filter(Boolean).join('\n\n'),
      operation: 'render'
    })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    const t = translator('app')

    return (
      <div className="crash">
        <FabricatorMark className="brand-mark" />
        <h1>{t('crash.title')}</h1>
        <p className="crash-sub">{t('crash.body')}</p>
        {error.message && (
          <details className="crash-details">
            <summary className="crash-details-summary">{t('crash.details')}</summary>
            <pre className="crash-detail">{error.message}</pre>
          </details>
        )}
        <div className="crash-actions">
          <button className="btn btn--primary" onClick={() => window.location.reload()}>
            {t('crash.reload')}
          </button>
          <button className="btn btn--ghost" onClick={() => void window.api.openLogs()}>
            {t('crash.openLogs')}
          </button>
        </div>
      </div>
    )
  }
}
