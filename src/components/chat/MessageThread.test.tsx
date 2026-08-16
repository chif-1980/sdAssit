import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProductCitation, ProductMessage } from '../../../shared/api/product.js'
import { MessageThread } from './MessageThread'

const citation: ProductCitation = {
  id: 'CIT-1',
  kind: 'ENTERPRISE_EVIDENCE',
  title: '项目上线规范',
  path: '产品中心 / 上线规范',
  locator: '第 3 节',
  excerpt: '上线前需要完成审批。',
  versionAt: '2026-08-12T00:00:00.000Z',
}

const firstMessage: ProductMessage = {
  id: 'MSG-1',
  role: 'USER',
  content: '第一个问题',
  answerStatus: null,
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
      messages={[firstMessage, { ...firstMessage, id: 'MSG-2', role: 'ASSISTANT', content: '最新回答', answerStatus: 'SUPPORTED' }]}
      onCitation={vi.fn()}
    />)

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'end' })
  })

  it.each([
    ['SUPPORTED', '有正式资料支持'],
    ['INSUFFICIENT', '依据不足'],
    ['CONFLICTING', '资料存在冲突'],
  ] as const)('shows the %s answer status as %s', (answerStatus, label) => {
    render(<MessageThread
      messages={[{ ...firstMessage, id: `MSG-${answerStatus}`, role: 'ASSISTANT', content: '回答正文', answerStatus }]}
      onCitation={vi.fn()}
    />)

    expect(screen.getByText(label)).toBeInTheDocument()
  })

  it('replaces an insufficient answer body with the fixed reliability message', () => {
    render(<MessageThread
      messages={[{ ...firstMessage, role: 'ASSISTANT', content: '不应展示的原始正文', answerStatus: 'INSUFFICIENT' }]}
      onCitation={vi.fn()}
    />)

    expect(screen.getByText('暂无足够可靠资料')).toBeInTheDocument()
    expect(screen.queryByText('不应展示的原始正文')).not.toBeInTheDocument()
  })

  it('passes the citation and trigger button to the selection handler', async () => {
    const user = userEvent.setup()
    const onCitation = vi.fn()
    render(<MessageThread
      messages={[{ ...firstMessage, role: 'ASSISTANT', content: '有出处的回答', answerStatus: 'SUPPORTED', citations: [citation] }]}
      onCitation={onCitation}
    />)

    const trigger = screen.getByRole('button', { name: '[1]' })
    await user.click(trigger)

    expect(onCitation).toHaveBeenCalledWith(citation, trigger)
  })

  it('links citation buttons to the source dialog and expands only the selected citation', () => {
    const secondCitation = { ...citation, id: 'CIT-2', title: '第二个来源' }
    render(<MessageThread
      messages={[{
        ...firstMessage,
        role: 'ASSISTANT',
        content: '有两个出处的回答',
        answerStatus: 'SUPPORTED',
        citations: [citation, secondCitation],
      }]}
      expandedCitationId="CIT-2"
      onCitation={vi.fn()}
    />)

    const first = screen.getByRole('button', { name: '[1]' })
    const second = screen.getByRole('button', { name: '[2]' })
    expect(first).toHaveAttribute('aria-controls', 'source-drawer')
    expect(first).toHaveAttribute('aria-haspopup', 'dialog')
    expect(first).toHaveAttribute('aria-expanded', 'false')
    expect(second).toHaveAttribute('aria-expanded', 'true')
  })
})
