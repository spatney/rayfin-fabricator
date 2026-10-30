import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { ToolKindIcon } from './icons'
import { toolKind, type ToolKind } from './toolPresentation'

afterEach(cleanup)

const drawn = (kind: ToolKind): string => render(<ToolKindIcon kind={kind} />).container.innerHTML

describe('ToolKindIcon', () => {
  it('gives the local backend tools their own icons in the work log', () => {
    const fallback = drawn('other')
    const status = drawn(toolKind('fabricator_local_status'))
    const call = drawn(toolKind('fabricator_local_call'))
    expect(status).not.toBe(fallback)
    expect(call).not.toBe(fallback)
    expect(call).not.toBe(status)
  })
})
