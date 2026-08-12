import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ConversationMessage } from '../../../shared/domain/models.js'
import { MessageThread } from './MessageThread'

const firstMessage: ConversationMessage = {
  id: 'MSG-1',
  conversationId: 'CVS-1',
  role: 'USER',
  text: '第一个问题',
  citations: [],
  createdAt: '2026-08-12T00:00:00.000Z',
}

afterEach(() => {
  cleanup()
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
})

describe('MessageThread', () => {
  it('scrolls the latest message into view after messages change', () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
    const { rerender } = render(<MessageThread messages={[firstMessage]} onCitation={vi.fn()} />)

    scrollIntoView.mockClear()
    rerender(<MessageThread
      messages={[firstMessage, { ...firstMessage, id: 'MSG-2', role: 'ASSISTANT', text: '最新回答' }]}
      onCitation={vi.fn()}
    />)

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'end' })
  })
})
