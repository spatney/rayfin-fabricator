import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { MigrationPage, MigrationState } from '@shared/ipc'
import MigrationCard from './MigrationCard'

const done = { status: 'done' as const }
const page = (name: string, order: number, status: MigrationPage['status'] = 'pending'): MigrationPage => ({
  name,
  displayName: name,
  order,
  kind: 'page',
  hidden: false,
  stem: `0${order + 1}-${name.toLowerCase()}`,
  status
})

function state(over: Partial<MigrationState> = {}): MigrationState {
  return {
    version: 1,
    dir: '.fabricator/migration/sales',
    alias: 'sales',
    source: { reportId: 'r1', reportName: 'Sales', workspaceId: 'ws', personal: false },
    stages: { definition: done, model: done, export: done, images: done },
    pages: [page('Overview', 0, 'done'), page('Regions', 1), page('Stores', 2)],
    pdfs: [],
    warnings: [],
    startedAt: '',
    dismissed: false,
    ...over
  }
}

function renderCard(props: Partial<Parameters<typeof MigrationCard>[0]> = {}) {
  const handlers = {
    onNext: vi.fn(),
    onRest: vi.fn(),
    onStopRest: vi.fn(),
    onRetry: vi.fn(),
    onSkipImages: vi.fn(),
    onDismiss: vi.fn()
  }
  render(<MigrationCard state={state()} drawing={false} chaining={false} {...handlers} {...props} />)
  return handlers
}

afterEach(() => cleanup())

describe('MigrationCard', () => {
  it('shows how far reading the report has come, with a way to skip a slow export', () => {
    const handlers = renderCard({
      state: state({
        stages: {
          definition: done,
          model: { status: 'failed', message: 'You need edit access to read the model.' },
          export: { status: 'running', progress: 40 },
          images: { status: 'pending' }
        }
      })
    })
    expect(screen.getByText('Reading the report')).toBeTruthy()
    expect(screen.getByText('40%')).toBeTruthy()
    expect(screen.getByText('Data model: You need edit access to read the model.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Skip page images' }))
    expect(handlers.onSkipImages).toHaveBeenCalled()
  })

  it('lists the pages and migrates the next one or the rest', () => {
    const handlers = renderCard()
    expect(screen.getByText('1 of 3 pages')).toBeTruthy()
    expect(screen.getByLabelText('1. Overview: Migrated')).toBeTruthy()
    expect(screen.getByLabelText('2. Regions: Not started')).toBeTruthy()
    expect(screen.getByText('Next: “Regions”.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Migrate next page' }))
    fireEvent.click(screen.getByRole('button', { name: 'Migrate the rest' }))
    expect(handlers.onNext).toHaveBeenCalled()
    expect(handlers.onRest).toHaveBeenCalled()
  })

  it('waits, offers a failed page again, and stops the rest', () => {
    const failed = state({ pages: [page('Overview', 0, 'done'), page('Regions', 1, 'failed'), page('Stores', 2)] })
    const handlers = renderCard({ state: failed, waiting: 'Waiting for the deploy to finish.' })
    expect(screen.getByText('Waiting for the deploy to finish.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Migrate next page' }) as HTMLButtonElement).disabled).toBe(true)
    cleanup()

    const again = renderCard({ state: failed })
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(again.onRetry).toHaveBeenCalledWith(1)
    cleanup()

    const running = renderCard({
      state: state({ pages: [page('Overview', 0, 'done'), page('Regions', 1, 'running'), page('Stores', 2)] }),
      chaining: true
    })
    expect(screen.getByText(/Copilot is migrating “Regions”\. The rest follow/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Stop after this page' }))
    expect(running.onStopRest).toHaveBeenCalled()
    expect(handlers.onNext).not.toHaveBeenCalled()
  })

  it('can be closed once every page is migrated, and stays closed', () => {
    const all = state({ pages: [page('Overview', 0, 'done')] })
    const handlers = renderCard({ state: all })
    expect(screen.getByText(/Every page is migrated/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(handlers.onDismiss).toHaveBeenCalled()
    cleanup()
    renderCard({ state: { ...all, dismissed: true } })
    expect(screen.queryByRole('region', { name: 'Power BI migration' })).toBeNull()
  })
})
