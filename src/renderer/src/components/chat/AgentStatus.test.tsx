import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { SupportingReview } from '@shared/ipc'
import { AgentStatus } from './AgentStatus'
import type { UIChatMessage } from './types'

afterEach(cleanup)

const turn = (reviews: SupportingReview[]): UIChatMessage => ({
  id: 'a1',
  role: 'assistant',
  text: '',
  tools: [],
  pending: true,
  supportingReviews: reviews
})

const card = (state: SupportingReview['state']): SupportingReview => ({
  id: 'r1',
  kind: 'apply',
  state,
  reason: 'the dashboard',
  items: []
})

describe('AgentStatus', () => {
  it('waits, without a timer, while a supporting items card waits for the user', () => {
    const { container } = render(<AgentStatus message={turn([card('pending')])} />)
    expect(screen.getByText('Waiting for your approval')).toBeTruthy()
    expect(container.querySelector('.agent-status-time')).toBeNull()
    cleanup()
    render(<AgentStatus message={turn([card('working')])} />)
    expect(screen.queryByText('Waiting for your approval')).toBeNull()
  })
})
