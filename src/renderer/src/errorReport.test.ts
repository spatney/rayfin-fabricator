import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ErrorReport } from '@shared/ipc'
import {
  errorMessage,
  inferArea,
  installGlobalErrorCapture,
  reportError,
  reportEvent,
  reportThrown,
  setErrorProject
} from './errorReport'

const record = vi.fn<(report: ErrorReport) => Promise<void>>(() => Promise.resolve())

beforeEach(() => {
  record.mockClear()
  record.mockImplementation(() => Promise.resolve())
  setErrorProject(undefined)
  ;(window as unknown as { api: unknown }).api = { diagnostics: { record } }
})

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

describe('recording errors', () => {
  it('sends the message, surface and inferred area', () => {
    reportError({ message: 'The deploy failed.', operation: 'deploy_run' })
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'The deploy failed.',
        operation: 'deploy_run',
        area: 'deploy',
        surface: 'toast',
        level: 'error'
      })
    )
  })

  it('attributes the error to the active project without the caller passing it', () => {
    setErrorProject('proj-7')
    reportError({ message: 'Something failed.' })
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'proj-7' }))
  })

  it('lets an explicit project id win over the active one', () => {
    setErrorProject('proj-7')
    reportError({ message: 'Something failed.', projectId: 'proj-9' })
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'proj-9' }))
  })

  it('ignores empty messages', () => {
    reportError({ message: '   ' })
    expect(record).not.toHaveBeenCalled()
  })

  it('never throws when the journal is unavailable', () => {
    delete (window as unknown as { api?: unknown }).api
    expect(() => reportError({ message: 'Still fine.' })).not.toThrow()
  })

  it('never throws when recording itself rejects', () => {
    record.mockImplementation(() => Promise.reject(new Error('disk full')))
    expect(() => reportError({ message: 'Still fine.' })).not.toThrow()
  })
})

describe('recording what went right', () => {
  // Without this, Help reads a journal of nothing but failures and tells a
  // user with a perfectly healthy app that it is broken.
  it('records a success as an info entry with its event name', () => {
    reportEvent('deploy', 'deploy.succeeded', 'Deployed to the Sales workspace.')
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'info',
        area: 'deploy',
        event: 'deploy.succeeded',
        message: 'Deployed to the Sales workspace.'
      })
    )
  })

  it('leaves the surface off, because nothing was shown as a problem', () => {
    reportEvent('setup', 'setup.completed', 'Setup finished.')
    expect(record.mock.calls[0][0].surface).toBeUndefined()
  })

  it('attributes a success to the active project too', () => {
    setErrorProject('proj-7')
    reportEvent('preview', 'preview.started', 'The preview is running.')
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'proj-7' }))
  })

  it('never throws when the journal is unavailable', () => {
    delete (window as unknown as { api?: unknown }).api
    expect(() => reportEvent('app', 'app.ok', 'Fine.')).not.toThrow()
  })
})

describe('reading a thrown value', () => {
  it('prefers an Error message and keeps its stack as detail', () => {
    const message = reportThrown(new Error('boom'), { operation: 'chat_send' })
    expect(message).toBe('boom')
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'boom', area: 'chat', surface: 'inline' })
    )
    expect(record.mock.calls[0][0].detail).toContain('boom')
  })

  it('accepts a bare string', () => {
    expect(reportThrown('plain failure')).toBe('plain failure')
  })

  it('falls back when there is nothing readable', () => {
    expect(reportThrown(null, { fallback: 'Could not load deployments.' })).toBe(
      'Could not load deployments.'
    )
  })

  it('reads a message off a plain object, as Tauri rejections arrive', () => {
    expect(errorMessage({ message: 'command failed' })).toBe('command failed')
  })
})

describe('grouping by area', () => {
  it.each([
    ['deploy_run', 'The deploy failed.', 'deploy'],
    [undefined, "Couldn't publish: Runtime settings sync failed", 'deploy'],
    [undefined, 'The local backend refused the control token', 'preview'],
    ['local_reset_data', 'Request failed', 'preview'],
    [undefined, 'Fabric sign-in did not complete', 'auth'],
    [undefined, 'All preview ports are busy', 'preview'],
    [undefined, 'Could not push the branch', 'git'],
    [undefined, 'The team workspace is locked', 'team'],
    [undefined, 'Node is missing — run the doctor', 'setup'],
    [undefined, 'Something inexplicable', 'app']
  ])('maps %s / %s to %s', (operation, message, area) => {
    expect(inferArea(operation, message)).toBe(area)
  })
})

describe('global capture', () => {
  it('records an uncaught exception', () => {
    const stop = installGlobalErrorCapture()
    window.dispatchEvent(
      new ErrorEvent('error', { message: 'undefined is not a function', error: new Error('boom') })
    )
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'unhandled', area: 'ui', message: 'boom' })
    )
    stop()
  })

  it('records an unhandled rejection', () => {
    const stop = installGlobalErrorCapture()
    const event = new Event('unhandledrejection') as Event & { reason: unknown }
    event.reason = new Error('a background task died')
    window.dispatchEvent(event)
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: 'unhandled',
        message: 'a background task died',
        operation: 'unhandledrejection'
      })
    )
    stop()
  })

  it('stops recording once torn down', () => {
    installGlobalErrorCapture()()
    // Without our listener, jsdom would surface this as an uncaught error and
    // fail the run, so swallow it here — the assertion is that we didn't record.
    const swallow = (event: ErrorEvent): void => event.preventDefault()
    window.addEventListener('error', swallow)
    window.dispatchEvent(
      new ErrorEvent('error', { error: new Error('ignored'), cancelable: true })
    )
    window.removeEventListener('error', swallow)
    expect(record).not.toHaveBeenCalled()
  })
})
