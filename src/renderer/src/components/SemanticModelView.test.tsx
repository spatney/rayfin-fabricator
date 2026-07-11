import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import SemanticModelView from './SemanticModelView'
import type { SemanticModelRef } from '../model/fabricConfig'
import { clearSchemaCache } from '../model/schemaCache'
import type { SemanticSchemaResult } from '@shared/ipc'

/**
 * SemanticModelView renders a Fabric/Power BI semantic model as an interactive ER
 * diagram, sibling to the Rayfin data-model view. These tests mock the live
 * `window.api.fabric.semanticModelSchema` bridge with an in-memory schema and
 * protect the two behaviours added this session:
 *   1. the schema is cached for the session (toggling the Model tab remounts this
 *      view, so it must NOT re-query Fabric), while an explicit Refresh / parent
 *      refreshKey bump forces a fresh read;
 *   2. clicking Focus isolates a table and its direct neighbours (others are
 *      removed from the DOM, as in the data-model view).
 */

const MODEL: SemanticModelRef = { alias: 'model', workspaceId: 'ws1', itemId: 'it1' }

function schema(): SemanticSchemaResult {
  return {
    ok: true,
    matched: true,
    tables: [
      { name: 'Orders', isHidden: false },
      { name: 'Customers', isHidden: false },
      { name: 'Regions', isHidden: false }
    ],
    columns: [
      { table: 'Orders', name: 'id', dataType: 'Int64', isHidden: false, isKey: true },
      { table: 'Orders', name: 'customer_id', dataType: 'Int64', isHidden: false, isKey: false },
      { table: 'Customers', name: 'id', dataType: 'Int64', isHidden: false, isKey: true },
      { table: 'Regions', name: 'id', dataType: 'Int64', isHidden: false, isKey: true }
    ],
    measures: [
      { table: 'Orders', name: 'Total Orders', expression: 'COUNTROWS ( Orders )', isHidden: false }
    ],
    relationships: [
      {
        fromTable: 'Orders',
        fromColumn: 'customer_id',
        fromCardinality: 'Many',
        toTable: 'Customers',
        toColumn: 'id',
        toCardinality: 'One',
        isActive: true,
        crossFilter: 'OneDirection'
      }
    ],
    notes: []
  }
}

function installApi(result: SemanticSchemaResult): ReturnType<typeof vi.fn> {
  const semanticModelSchema = vi.fn(async () => result)
  ;(window as unknown as { api: unknown }).api = { fabric: { semanticModelSchema } }
  return semanticModelSchema
}

function hasCard(name: string): boolean {
  return [...document.querySelectorAll('.semantic-card-name')].some(
    (b) => b.textContent?.trim() === name
  )
}

function cardOf(name: string): HTMLElement {
  const nameEl = [...document.querySelectorAll('.semantic-card-name')].find(
    (b) => b.textContent?.trim() === name
  )
  const card = nameEl?.closest('.semantic-card')
  if (!card) throw new Error(`No card for ${name}`)
  return card as HTMLElement
}

beforeEach(() => {
  clearSchemaCache()
})

afterEach(() => {
  cleanup()
  clearSchemaCache()
  localStorage.clear()
  delete (window as unknown as { api?: unknown }).api
})

describe('SemanticModelView', () => {
  it('caches the schema across remounts and refetches on Refresh', async () => {
    const fetchSchema = installApi(schema())
    const first = render(<SemanticModelView projectId="p1" models={[MODEL]} refreshKey={0} />)
    await screen.findByText('Orders')
    expect(fetchSchema).toHaveBeenCalledTimes(1)

    // The Model tab remounts this view when toggling Data <-> Semantic: served
    // from the session cache, so Fabric is NOT queried again.
    first.unmount()
    render(<SemanticModelView projectId="p1" models={[MODEL]} refreshKey={0} />)
    await screen.findByText('Orders')
    expect(fetchSchema).toHaveBeenCalledTimes(1)

    // Refresh always reads fresh from Fabric.
    fireEvent.click(screen.getByTitle('Refresh from Fabric'))
    await screen.findByText('Orders')
    expect(fetchSchema).toHaveBeenCalledTimes(2)
  })

  it('refetches when the parent refreshKey changes', async () => {
    const fetchSchema = installApi(schema())
    const { rerender } = render(
      <SemanticModelView projectId="p1" models={[MODEL]} refreshKey={0} />
    )
    await screen.findByText('Orders')
    expect(fetchSchema).toHaveBeenCalledTimes(1)

    rerender(<SemanticModelView projectId="p1" models={[MODEL]} refreshKey={1} />)
    await screen.findByText('Orders')
    expect(fetchSchema).toHaveBeenCalledTimes(2)
  })

  it('fits the initial layout before paint instead of scheduling a second-frame camera jump', async () => {
    const originalRaf = globalThis.requestAnimationFrame
    const raf = vi.fn(() => 1)
    globalThis.requestAnimationFrame = raf as typeof requestAnimationFrame
    try {
      installApi(schema())
      render(<SemanticModelView projectId="p1" models={[MODEL]} refreshKey={0} />)

      await screen.findByText('Orders')

      expect(raf).not.toHaveBeenCalled()
    } finally {
      globalThis.requestAnimationFrame = originalRaf
    }
  })

  it('isolates a table and its neighbours when focused', async () => {
    installApi(schema())
    render(<SemanticModelView projectId="p1" models={[MODEL]} refreshKey={0} />)
    await screen.findByText('Orders')

    // Focus Orders → Orders + its neighbour Customers remain; disconnected Regions
    // is removed from the DOM.
    fireEvent.click(within(cardOf('Orders')).getByLabelText('Focus this table'))
    expect(hasCard('Orders')).toBe(true)
    expect(hasCard('Customers')).toBe(true)
    expect(hasCard('Regions')).toBe(false)
    expect(screen.getByText(/Focusing Orders/)).toBeTruthy()

    // Clearing focus via the chip restores every table.
    fireEvent.click(screen.getByText(/Focusing Orders/))
    expect(hasCard('Orders')).toBe(true)
    expect(hasCard('Customers')).toBe(true)
    expect(hasCard('Regions')).toBe(true)
  })
})
