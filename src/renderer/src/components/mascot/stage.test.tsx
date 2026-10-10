import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MascotProvider, resetMascotForTests, useMascotInstall, type InstallStatus } from './stage'
import type { Occasion } from './lines'

function Install({
  status,
  occasion = 'create'
}: {
  status: InstallStatus
  occasion?: Occasion
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useMascotInstall(occasion, status, ref)
  return <div ref={ref} />
}

const ray = (): HTMLElement | null =>
  screen.queryByRole('button', { name: /Ray, the Fabricator stingray/ })
const said = (): string => document.querySelector('.mascot-bubble')?.textContent ?? ''

function stage(children: ReactNode, enabled = true): JSX.Element {
  return <MascotProvider enabled={enabled}>{children}</MascotProvider>
}

const wait = (ms: number): void =>
  act(() => {
    vi.advanceTimersByTime(ms)
  })

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  // With reduced motion Ray appears in place and speaks at once, so these
  // tests need timers but no animation frames.
  window.matchMedia = ((query: string) => ({
    matches: query.includes('reduce'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  resetMascotForTests()
  delete (window as unknown as { matchMedia?: unknown }).matchMedia
})

describe('Ray during installs', () => {
  it('swims in once an install has run a moment, and introduces himself', () => {
    render(stage(<Install status="running" />))
    expect(ray()).toBeNull()
    wait(700)
    expect(ray()).not.toBeNull()
    expect(said()).toMatch(/^Hi, I’m Ray!/)
  })

  it('never turns up for a quick check', () => {
    const view = render(stage(<Install status="running" occasion="prepare" />))
    wait(1000)
    view.rerender(stage(<Install status="success" occasion="prepare" />))
    wait(10_000)
    expect(ray()).toBeNull()
  })

  it('celebrates a success, then swims off', () => {
    const view = render(stage(<Install status="running" />))
    wait(700)
    view.rerender(stage(<Install status="success" />))
    expect(said()).toMatch(/Your app is ready!/)
    wait(10_000)
    expect(ray()).toBeNull()
  })

  it('stays with a failure until its screen closes', () => {
    const view = render(stage(<Install status="running" />))
    wait(700)
    view.rerender(stage(<Install status="error" />))
    expect(said()).toMatch(/Oh no/)
    wait(20_000)
    expect(ray()).not.toBeNull()

    view.rerender(stage(<div />))
    wait(2000)
    expect(ray()).toBeNull()
  })

  it('picks straight back up when the user retries', () => {
    const view = render(stage(<Install status="running" />))
    wait(700)
    view.rerender(stage(<Install status="error" />))
    view.rerender(stage(<Install status="running" />))
    expect(said()).toMatch(/Round two/)
  })

  it('still celebrates when success closes the screen in the same moment', () => {
    let succeed = (): void => {}
    function Clone(): JSX.Element {
      const ref = useRef<HTMLDivElement>(null)
      succeed = useMascotInstall('clone', 'running', ref).succeed
      return <div ref={ref} />
    }
    const view = render(stage(<Clone />))
    wait(700)
    act(() => {
      succeed()
      view.rerender(stage(<div />))
    })
    expect(said()).toMatch(/All set!/)
  })

  it('stays away for the rest of the session once sent away', () => {
    const view = render(stage(<Install status="running" />))
    wait(700)
    fireEvent.click(screen.getByRole('button', { name: 'Send Ray away for now' }))
    expect(said()).toMatch(/bye for now/)
    wait(5000)
    expect(ray()).toBeNull()

    view.rerender(stage(<Install status="idle" />))
    view.rerender(stage(<Install status="running" />))
    wait(5000)
    expect(ray()).toBeNull()
  })

  it('never appears when turned off in Settings', () => {
    render(stage(<Install status="running" />, false))
    wait(5000)
    expect(ray()).toBeNull()
  })
})
