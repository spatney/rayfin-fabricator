import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { ErrorReport } from '@shared/ipc'
import { ToastProvider, useToast, type ToastApi } from './toast'

import type { JSX } from 'react'

const record = vi.fn<(report: ErrorReport) => Promise<void>>(() => Promise.resolve())

let api: ToastApi

function Probe(): JSX.Element {
  api = useToast()
  return <span>probe</span>
}

beforeEach(() => {
  record.mockClear()
  ;(window as unknown as { api: unknown }).api = { diagnostics: { record } }
  render(
    <ToastProvider>
      <Probe />
    </ToastProvider>
  )
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('what a toast puts in the activity journal', () => {
  it('records an error toast as a failure', () => {
    api.error('The deploy failed.', { title: 'Deploy' })
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'error',
        area: 'deploy',
        surface: 'toast',
        message: 'Deploy: The deploy failed.'
      })
    )
  })

  // The toasts people are shown when things work are the record that proves an
  // earlier failure is over. Dropping them is what made Help describe a healthy
  // app as broken.
  it('records a success toast too, as an info entry', () => {
    api.success('Your app is live.', { title: 'Deployed' })
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'info',
        area: 'deploy',
        event: 'deploy.succeeded',
        message: 'Deployed: Your app is live.'
      })
    )
  })

  it('records an info toast as a notice rather than a success', () => {
    api.info('Preview stopped.')
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'info', event: 'preview.notice' })
    )
  })

  it('stays quiet when the caller already recorded it with more detail', () => {
    api.error('Already logged.', { record: false })
    api.success('Also already logged.', { record: false })
    expect(record).not.toHaveBeenCalled()
  })

  it('still shows the toast', () => {
    act(() => {
      api.success('Your app is live.')
    })
    expect(screen.getByText('Your app is live.')).toBeTruthy()
  })
})
