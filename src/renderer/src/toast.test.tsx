import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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

describe('staying out of the way', () => {
  afterEach(() => vi.useRealTimers())

  it('waits while you read it: pointing at a toast pauses its countdown', () => {
    vi.useFakeTimers()
    act(() => {
      api.success('Your app is live.')
    })
    const toast = screen.getByRole('status')
    fireEvent.mouseEnter(toast)
    act(() => vi.advanceTimersByTime(10_000))
    expect(screen.queryByText('Your app is live.')).toBeTruthy()

    fireEvent.mouseLeave(toast)
    act(() => vi.advanceTimersByTime(4_000))
    expect(screen.queryByText('Your app is live.')).toBeNull()
  })

  it('shows the same news once instead of stacking copies', () => {
    act(() => {
      api.error('Port 5173 is in use.')
      api.error('Port 5173 is in use.')
    })
    expect(screen.getAllByText('Port 5173 is in use.')).toHaveLength(1)
  })

  it('stays paused when the same news comes again while you point at it', () => {
    vi.useFakeTimers()
    act(() => {
      api.success('Saved.')
    })
    const toast = screen.getByRole('status')
    fireEvent.mouseEnter(toast)
    act(() => {
      api.success('Saved.')
    })
    act(() => vi.advanceTimersByTime(10_000))
    expect(screen.queryByText('Saved.')).toBeTruthy()

    fireEvent.mouseLeave(toast)
    act(() => vi.advanceTimersByTime(4_000))
    expect(screen.queryByText('Saved.')).toBeNull()
  })
})
