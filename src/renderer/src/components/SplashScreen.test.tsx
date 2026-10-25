import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import SplashScreen, { SPEAK_AT_MS, SWIM_IN, SWIM_OUT, swimPoint } from './SplashScreen'
import { SPLASH_LINES, splashGreeting } from './mascot/lines'

beforeEach(() => {
  vi.useFakeTimers()
  // jsdom draws no canvas; Ray swims without his ripples here.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  localStorage.clear()
})

const said = (): string => screen.getByRole('status').textContent ?? ''
/** Let `ms` pass in small steps, so React catches up between timers as it would live. */
function wait(ms: number): void {
  for (let t = 0; t < ms; t += 100) act(() => void vi.advanceTimersByTime(100))
}

describe('SplashScreen', () => {
  it('is Ray’s, over the wordmark', () => {
    const { container } = render(<SplashScreen />)
    expect(container.querySelector('.ray-perch-ray svg.ray')).not.toBeNull()
    expect(container.querySelector('.splash-word--mark')).not.toBeNull()
  })

  it('says how the checks are going, in plain words, under the wordmark', () => {
    const line = (): string => document.querySelector('.splash-status')?.textContent ?? ''
    const { rerender } = render(<SplashScreen stage="tools" />)
    expect(line()).toBe('Checking your tools')
    rerender(<SplashScreen stage="accounts" />)
    expect(line()).toBe('Checking your sign-ins')
    rerender(<SplashScreen stage="setup" />)
    expect(line()).toBe('A few things to set up first')
    rerender(<SplashScreen stage="ready" />)
    expect(line()).toBe('All set')
    rerender(<SplashScreen stage="ready" opening="Lead Tracker" />)
    expect(line()).toBe('LOpening Lead Tracker')
  })

  it('introduces Ray first, holding his hello long enough to read', () => {
    const { rerender, unmount } = render(<SplashScreen stage="tools" />)
    expect(said()).toBe(splashGreeting(true))
    rerender(<SplashScreen stage="ready" />)
    wait(1000)
    expect(said()).toBe(splashGreeting(true))
    wait(700)
    expect(said()).toBe(SPLASH_LINES.ready[0])
    unmount()

    // Met now: next time he just says hello.
    render(<SplashScreen stage="tools" />)
    expect(said()).toBe(splashGreeting(false))
  })

  it('keeps talking while a step takes a while', () => {
    render(<SplashScreen stage="accounts" />)
    wait(1700)
    expect(said()).toBe(SPLASH_LINES.accounts[0])
    wait(2000)
    expect(said()).toBe(SPLASH_LINES.accounts[1])
  })
})

describe('SplashScreen at a later launch', () => {
  it('has Ray say welcome back over the building wordmark, without narrating checks', () => {
    localStorage.setItem('fabricator.mascot.met', '1')
    const { container, rerender } = render(<SplashScreen launch stage="tools" />)
    expect(container.querySelector('.ray-perch-ray svg.ray')).not.toBeNull()
    expect(container.querySelector('.splash-word--mark')).not.toBeNull()
    const hello = said()
    expect(hello).toMatch(/welcome back/i)

    // The checks run in the background; he doesn't talk them through.
    rerender(<SplashScreen launch stage="accounts" />)
    wait(4000)
    expect(said()).toBe(hello)
    expect(Object.values(SPLASH_LINES).flat()).not.toContain(said())
  })

  it('introduces Ray if this is the first time they meet', () => {
    const { unmount } = render(<SplashScreen launch />)
    expect(said()).toBe('Hi, I’m Ray! Welcome back.')
    unmount()
    render(<SplashScreen launch />)
    expect(said()).not.toMatch(/I’m Ray/)
  })

  it('names the project it’s opening, with its initial, once that’s known', () => {
    const line = (): string => document.querySelector('.splash-status')?.textContent ?? ''
    const { container, rerender } = render(<SplashScreen launch />)
    // Not known yet: nothing, and no "Checking…" either, since the checks run behind.
    expect(line()).toBe('')
    rerender(<SplashScreen launch opening="lead-tracker" />)
    expect(line()).toBe('LOpening lead-tracker')
    expect(container.querySelector('.splash-status-mark')?.textContent).toBe('L')
    rerender(<SplashScreen launch opening={null} />)
    expect(line()).toBe('Opening your projects')
  })

  it('has Ray speak once he has swum into his spot, not on his way', () => {
    localStorage.setItem('fabricator.mascot.met', '1')
    const { container } = render(<SplashScreen launch />)
    const bubble = (): Element | null => container.querySelector('.mascot-bubble')
    expect(bubble()).toBeNull()
    // Screen readers get his hello at once.
    expect(said()).toMatch(/welcome back/i)

    act(() => void vi.advanceTimersByTime(SPEAK_AT_MS - 1))
    expect(bubble()).toBeNull()
    act(() => void vi.advanceTimersByTime(1))
    expect(bubble()).not.toBeNull()
  })

  it('swims him in to his spot nose up, and out the way he faces', () => {
    const from = swimPoint(SWIM_IN, 0)
    expect([from.x, from.y]).toEqual([SWIM_IN[0][0], SWIM_IN[0][1]])
    // Coming in from the left, he faces right.
    expect(from.angle).toBeGreaterThan(60)
    const home = swimPoint(SWIM_IN, 1)
    expect([home.x, home.y, home.angle]).toEqual([0, 0, 0])

    const away = swimPoint(SWIM_OUT, 0)
    expect([away.x, away.y, away.angle]).toEqual([0, 0, 0])
    const gone = swimPoint(SWIM_OUT, 1)
    expect(gone.y).toBeLessThan(-200)
    expect(gone.angle).toBeGreaterThan(0)
  })

  it('lets him leave when the screen lifts', () => {
    localStorage.setItem('fabricator.mascot.met', '1')
    const { container, rerender } = render(<SplashScreen launch opening="lead-tracker" />)
    act(() => void vi.advanceTimersByTime(2000))
    rerender(<SplashScreen launch opening="lead-tracker" leaving />)
    act(() => void vi.advanceTimersByTime(1000))
    expect(container.querySelector('.splash-word--mark')).not.toBeNull()
  })
})
