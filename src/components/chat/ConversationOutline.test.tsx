import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProductMessage } from '../../../shared/api/product.js'
import { ConversationOutline } from './ConversationOutline'

function message(id: string, role: ProductMessage['role'], content: string): ProductMessage {
  return {
    id,
    role,
    content,
    answerStatus: role === 'ASSISTANT' ? 'SUPPORTED' : null,
    citations: [],
    createdAt: '2026-08-12T00:00:00.000Z',
  }
}

const messages = [
  message('Q-1', 'USER', '第一组问题'), message('A-1', 'ASSISTANT', '第一组回答'),
  message('Q-2', 'USER', '第二组问题'), message('A-2', 'ASSISTANT', '第二组回答'),
  message('Q-3', 'USER', '第三组问题'), message('A-3', 'ASSISTANT', '第三组回答'),
]

afterEach(cleanup)

describe('ConversationOutline', () => {
  it('shows a compact outline only for longer conversations and previews the hovered pair', () => {
    const onActivate = vi.fn()
    const onHighlight = vi.fn()
    const view = render(<ConversationOutline messages={messages} activePairId="Q-1" onActivate={onActivate} onHighlight={onHighlight} />)

    const markers = screen.getAllByRole('button', { name: /定位到第/ })
    expect(markers).toHaveLength(3)
    expect(markers[0]).toHaveAttribute('aria-current', 'location')
    expect(screen.getByText('第 1 / 3 组问答')).toBeInTheDocument()

    view.rerender(<ConversationOutline messages={messages} activePairId="Q-3" onActivate={onActivate} onHighlight={onHighlight} />)
    expect(screen.getByText('第 3 / 3 组问答')).toBeInTheDocument()

    fireEvent.mouseEnter(markers[1])
    expect(screen.getByText('第二组问题')).toBeInTheDocument()
    expect(screen.getByText('第二组回答')).toBeInTheDocument()
    expect(onHighlight).toHaveBeenLastCalledWith('Q-2')

    fireEvent.mouseLeave(markers[1])
    expect(screen.queryByText('第二组回答')).not.toBeInTheDocument()
    expect(onHighlight).toHaveBeenLastCalledWith(undefined)
  })

  it('activates the selected pair from the marker', () => {
    const onActivate = vi.fn()
    render(<ConversationOutline messages={messages} onActivate={onActivate} onHighlight={vi.fn()} />)

    fireEvent.click(screen.getAllByRole('button', { name: /定位到第/ })[2])
    expect(onActivate).toHaveBeenCalledWith('Q-3')
  })

  it('does not add navigation noise to short conversations', () => {
    render(<ConversationOutline messages={messages.slice(0, 4)} onActivate={vi.fn()} onHighlight={vi.fn()} />)
    expect(screen.queryByLabelText('对话导航')).not.toBeInTheDocument()
  })
})
