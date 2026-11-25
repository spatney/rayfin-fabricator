import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { SemanticSchemaResult } from '@shared/ipc'
import SupportingModelDialog from './SupportingModelDialog'
import { BlueprintHeadSlot } from '../blueprint/ViewHead'
import { ToastProvider } from '../../toast'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

const schema: SemanticSchemaResult = {
  ok: true,
  matched: true,
  tables: [{ name: 'Sales', isHidden: false, storageMode: 'import' }],
  columns: [
    { table: 'Sales', name: 'Revenue', dataType: 'decimal', isHidden: false, isKey: false }
  ],
  measures: [],
  relationships: [],
  notes: []
}

describe('SupportingModelDialog', () => {
  it('draws the folder’s model with its header in the dialog, even when opened from Blueprint', async () => {
    const read = vi.fn(async () => schema)
    ;(window as unknown as { api: unknown }).api = { supportingItems: { schema: read } }
    // Blueprint's header row, where its own views put their summary and legend.
    const blueprintHead = document.createElement('div')
    document.body.appendChild(blueprintHead)

    render(
      <ToastProvider>
        <BlueprintHeadSlot.Provider value={blueprintHead}>
          <SupportingModelDialog
            projectId="p1"
            name="Sales"
            folder="supporting-items/Sales.SemanticModel"
            onClose={() => {}}
          />
        </BlueprintHeadSlot.Provider>
      </ToastProvider>
    )

    const dialog = await screen.findByRole('dialog', { name: 'Sales' })
    expect(dialog.textContent).toContain('As defined in')
    expect(dialog.textContent).toContain('supporting-items/Sales.SemanticModel')
    await waitFor(() => expect(dialog.querySelector('.model-head')).not.toBeNull())
    expect(read).toHaveBeenCalledWith('p1', 'Sales.SemanticModel')
    expect(blueprintHead.childNodes).toHaveLength(0)
  })
})
