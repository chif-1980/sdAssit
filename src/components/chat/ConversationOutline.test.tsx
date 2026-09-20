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

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('ConversationOutline', () => {
  it('shows a plain-text summary and supports keyboard preview and dismissal', () => {
    const formatted = messages.map(item => item.id === 'A-2'
      ? { ...item, content: '## 结论\n**智能客服**是一套平台，查看[产品说明](https://example.com)。[3] 支持 `API`。' }
      : item)
    render(<ConversationOutline messages={formatted} onActivate={vi.fn()} onHighlight={vi.fn()} />)
    const marker = screen.getAllByRole('button', { name: /定位到第/ })[1]
    fireEvent.focus(marker)
    const preview = screen.getByRole('tooltip')
    expect(preview).toHaveTextContent('智能客服是一套平台，查看产品说明。 支持 API。')
    expect(preview.textContent).not.toMatch(/\*\*|##|https:\/\/|\[3\]|`/u)
    expect(marker).toHaveAttribute('aria-describedby', preview.id)
    fireEvent.keyDown(marker, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('anchors previews to each marker and keeps the first and last fully inside the rail', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const index = Number(this.getAttribute('aria-label')?.match(/第 (\d+)/u)?.[1] || 0)
      const top = index ? [104, 360, 680][index - 1] : 100
      const height = index ? 24 : 600
      return { top, bottom: top + height, left: 280, right: 310, width: 30, height, x: 280, y: top, toJSON() {} }
    })
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(200)
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(300)
    render(<ConversationOutline messages={messages} onActivate={vi.fn()} onHighlight={vi.fn()} />)
    const markers = screen.getAllByRole('button', { name: /定位到第/ })
    for (const [index, top] of [100, 272, 500].entries()) {
      fireEvent.mouseEnter(markers[index])
      expect(screen.getByRole('tooltip')).toHaveStyle({ top: `${top}px` })
      fireEvent.mouseLeave(markers[index])
    }
  })

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
