import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import DeployFailedNotice, { deployTrouble, type DeployFailedNoticeProps } from './DeployFailedNotice'
import { isRaySentAway } from './mascot/stage'

vi.mock('./mascot/stage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mascot/stage')>()),
  isRaySentAway: vi.fn(() => false)
}))

function show(props: Partial<DeployFailedNoticeProps> = {}): DeployFailedNoticeProps {
  const all: DeployFailedNoticeProps = {
    outcome: 'error',
    log: ['[rayfin] settings: Applying runtime settings\n', '❌ Deployment failed: 400 Bad Request\n'],
    error: 'Runtime settings sync failed: 400 Bad Request',
    onDiagnose: vi.fn(),
    onRefreshAuth: vi.fn(),
    onDismiss: vi.fn(),
    ...props
  }
  render(<DeployFailedNotice {...all} />)
  return all
}

/** Make the OS ask for less motion, as Settings → Accessibility does. */
function preferReducedMotion(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {}
  }))
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.mocked(isRaySentAway).mockReturnValue(false)
})

describe('what a failed deploy offers', () => {
  it('sorts outcomes into what can be done about them', () => {
    expect(deployTrouble('error')).toBe('failed')
    expect(deployTrouble('not-found')).toBe('failed')
    expect(deployTrouble(undefined)).toBe('failed')
    expect(deployTrouble('not-signed-in')).toBe('signin')
    expect(deployTrouble('auth-cache-error')).toBe('signin')
    expect(deployTrouble('cancelled')).toBe('stopped')
  })

  it('has Ray swim in and say it, then offer to find out why', () => {
    const props = show()
    expect(screen.getByRole('alert').textContent).toBe(
      'That deploy didn’t make it to Fabric. Want me to find out why?'
    )
    act(() => vi.advanceTimersByTime(800))
    fireEvent.click(screen.getByRole('button', { name: /^Ray, the Fabricator stingray/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Find out why' }))
    expect(props.onDiagnose).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('button', { name: 'Refresh Fabric authentication' })).toBeNull()
  })

  it('says the same thing plainly once Ray was sent away', () => {
    vi.mocked(isRaySentAway).mockReturnValue(true)
    const props = show()
    expect(screen.getByRole('alert').textContent).toBe('The deploy didn’t finish. Help can find out why.')
    expect(screen.queryByRole('button', { name: /Ray/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Find out why' }))
    expect(props.onDiagnose).toHaveBeenCalledOnce()
  })

  it('leads with signing in again when that is what went wrong', () => {
    const props = show({ outcome: 'auth-cache-error', authBusy: false })
    const refresh = screen.getByRole('button', { name: 'Refresh Fabric authentication' })
    expect(refresh.className).toContain('btn--primary')
    expect(screen.getByRole('button', { name: 'Find out why' }).className).not.toContain('btn--primary')
    fireEvent.click(refresh)
    expect(props.onRefreshAuth).toHaveBeenCalledOnce()
  })

  it('waits for another sign-in or deploy before refreshing', () => {
    const props = show({ outcome: 'not-signed-in', authBusy: true })
    const refresh = screen.getByRole('button', { name: 'Refresh Fabric authentication' }) as HTMLButtonElement
    expect(refresh.disabled).toBe(true)
    fireEvent.click(refresh)
    expect(props.onRefreshAuth).not.toHaveBeenCalled()
  })

  it('offers nothing to diagnose for a deploy that was stopped', () => {
    show({ outcome: 'cancelled' })
    expect(screen.queryByRole('button', { name: 'Find out why' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Ray/ })).toBeNull()
  })
})

describe('the details', () => {
  it('keeps the log folded away until asked for', () => {
    show()
    expect(screen.queryByText(/Applying runtime settings/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'View logs' }))
    expect(screen.getByText(/Applying runtime settings/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Hide logs' }))
    expect(screen.queryByText(/Applying runtime settings/)).toBeNull()
  })

  it('shows the error for a deploy from an earlier session, which has no log', () => {
    show({ log: undefined })
    fireEvent.click(screen.getByRole('button', { name: 'Show details' }))
    expect(screen.getByText('Runtime settings sync failed: 400 Bad Request')).toBeTruthy()
  })

  it('has nothing to unfold when there is nothing to show', () => {
    show({ log: [], error: '  ' })
    expect(screen.queryByRole('button', { name: /logs|details/ })).toBeNull()
  })
})

describe('putting it away', () => {
  it('goes once it has swum off', () => {
    const props = show()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(props.onDismiss).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(300))
    expect(props.onDismiss).toHaveBeenCalledOnce()
  })

  it('goes at once when the OS asks for less motion', () => {
    preferReducedMotion()
    const props = show()
    // Nothing to wait for: Ray is already there and speaking.
    expect(screen.getByRole('button', { name: /^Ray/ }).className).not.toContain('is-arriving')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(props.onDismiss).toHaveBeenCalledOnce()
  })
})
