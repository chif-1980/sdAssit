import { act, cleanup, render, screen, within } from '@testing-library/react'
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
  vi.useRealTimers()
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

  it('does not scroll when only an existing answer feedback state changes', () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
    const assistantMessage: ProductMessage = {
      ...firstMessage,
      id: 'MSG-ASSISTANT',
      role: 'ASSISTANT',
      content: '回答正文',
      answerStatus: 'SUPPORTED',
      feedbackRating: null,
    }
    const { rerender } = render(<MessageThread messages={[assistantMessage]} onCitation={vi.fn()} />)

    scrollIntoView.mockClear()
    rerender(<MessageThread
      messages={[{ ...assistantMessage, feedbackRating: 'LIKE' }]}
      onCitation={vi.fn()}
    />)

    expect(scrollIntoView).not.toHaveBeenCalled()
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

  it('shows mutually exclusive feedback controls only for assistant answers', async () => {
    const user = userEvent.setup()
    const onFeedback = vi.fn()
    const assistantMessage: ProductMessage = {
      ...firstMessage,
      id: 'MSG-ASSISTANT',
      role: 'ASSISTANT',
      content: '回答正文',
      answerStatus: 'SUPPORTED',
      feedbackRating: null,
    }
    const { rerender } = render(<MessageThread
      messages={[firstMessage, assistantMessage]}
      onCitation={vi.fn()}
      onFeedback={onFeedback}
    />)

    const like = screen.getByRole('button', { name: '点赞这条回答' })
    const dislike = screen.getByRole('button', { name: '点踩这条回答' })
    expect(like).toHaveAttribute('aria-pressed', 'false')
    expect(dislike).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getAllByLabelText('回答反馈')).toHaveLength(1)
    await user.click(like)
    expect(onFeedback).toHaveBeenCalledWith('MSG-ASSISTANT', 'LIKE')

    rerender(<MessageThread
      messages={[firstMessage, { ...assistantMessage, feedbackRating: 'LIKE' }]}
      onCitation={vi.fn()}
      onFeedback={onFeedback}
    />)
    expect(screen.getByRole('button', { name: '点赞这条回答' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '点踩这条回答' })).toHaveAttribute('aria-pressed', 'false')
    await user.click(screen.getByRole('button', { name: '点赞这条回答' }))
    await user.click(screen.getByRole('button', { name: '点踩这条回答' }))
    expect(screen.getByRole('dialog', { name: '选择不满意原因' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '提交反馈' }))
    expect(onFeedback).toHaveBeenNthCalledWith(2, 'MSG-ASSISTANT', null)
    expect(onFeedback).toHaveBeenNthCalledWith(3, 'MSG-ASSISTANT', 'DISLIKE', 'CONTENT_ERROR', undefined)

    rerender(<MessageThread
      messages={[assistantMessage]}
      feedbackPendingIds={new Set(['MSG-ASSISTANT'])}
      onCitation={vi.fn()}
      onFeedback={onFeedback}
    />)
    expect(screen.getByRole('button', { name: '点赞这条回答' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '点踩这条回答' })).toBeDisabled()
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

  it('renders an image citation in the answer body without repeating it in the footer', async () => {
    const user = userEvent.setup()
    const onCitation = vi.fn()
    const imageCitation: ProductCitation = {
      ...citation,
      mediaType: 'IMAGE',
      imageUrl: '/minio/public/docs/architecture.png',
      previewUrl: '/minio/public/docs/previews/architecture.webp',
      imageAlt: '系统架构图',
    }
    render(<MessageThread
      messages={[{ ...firstMessage, role: 'ASSISTANT', content: '架构如下。[1] 后文再次引用。[1]', answerStatus: 'SUPPORTED', citations: [imageCitation] }]}
      onCitation={onCitation}
    />)

    const trigger = screen.getByRole('button', { name: '查看图片来源 [1]' })
    expect(trigger).toHaveClass('inline-image-citation')
    expect(trigger.querySelector('img')).toHaveAttribute('src', imageCitation.previewUrl)
    expect(trigger).toHaveTextContent('[1]系统架构图')
    expect(screen.getAllByRole('button', { name: '查看图片来源 [1]' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: '查看来源 [1]' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '[1]' })).not.toBeInTheDocument()
    await user.click(trigger)
    expect(onCitation).toHaveBeenCalledWith(imageCitation, trigger)
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

  it('keeps the pending state compact and reveals the processing timeline on demand', async () => {
    const user = userEvent.setup()
    render(<MessageThread
      messages={[firstMessage]}
      pendingQuestion="部署前需要准备什么？"
      answerProgress={{ stage: 'UNDERSTANDING', message: '正在结合当前对话理解问题' }}
      onCitation={vi.fn()}
    />)

    expect(screen.getAllByText('部署前需要准备什么？')).toHaveLength(1)
    const status = screen.getByRole('status', { name: '正在整理答案' })
    expect(status).not.toHaveTextContent('部署前需要准备什么？')
    expect(within(status).getByText('理解问题')).toBeInTheDocument()
    expect(within(status).getByText('检索资料')).toBeInTheDocument()
    expect(within(status).getByText('核对依据')).toBeInTheDocument()
    expect(within(status).getByText('组织答案')).toBeInTheDocument()
    const toggle = screen.getByRole('button', { name: '查看处理详情' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('正在结合当前对话理解问题')).toBeInTheDocument()
    expect(screen.getByText('我会优先返回有正式资料支持、并附上出处的答案。')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '收起处理详情' }))
    expect(screen.getByRole('button', { name: '查看处理详情' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('changes stage only from backend progress and explains a longer wait', () => {
    vi.useFakeTimers()
    const { rerender } = render(<MessageThread
      messages={[]}
      pendingQuestion="查一下部署要求"
      answerProgress={{ stage: 'RETRIEVING', message: '正在检索已审核发布的资料' }}
      onCitation={vi.fn()}
    />)

    act(() => vi.advanceTimersByTime(9_000))
    expect(screen.getByText('检索资料').closest('li')).toHaveClass('is-current')
    expect(screen.getByText('组织答案').closest('li')).not.toHaveClass('is-current')

    rerender(<MessageThread
      messages={[]}
      pendingQuestion="查一下部署要求"
      answerProgress={{ stage: 'COMPOSING', message: '正在整理结论和可核验来源' }}
      onCitation={vi.fn()}
    />)
    expect(screen.getByText('组织答案').closest('li')).toHaveClass('is-current')
    expect(screen.getByText('正在整理结论和可核验来源')).toBeInTheDocument()

    act(() => vi.advanceTimersByTime(4_000))
    act(() => screen.getByRole('button', { name: '查看处理详情' }).click())
    expect(screen.getByText('资料较多，我还在逐条核对来源。这个过程可能需要一点时间。')).toBeInTheDocument()
  })

  it('plays progress events in order when several stages arrive together', () => {
    vi.useFakeTimers()
    render(<MessageThread
      messages={[]}
      pendingQuestion="查一下部署要求"
      answerProgress={{ stage: 'COMPOSING', message: '正在整理结论和可核验来源' }}
      answerProgressTrail={[
        { stage: 'UNDERSTANDING', message: '正在结合当前对话理解问题' },
        { stage: 'RETRIEVING', message: '正在检索已审核发布的资料' },
        { stage: 'VERIFYING', message: '正在核对原文与适用条件' },
        { stage: 'COMPOSING', message: '正在整理结论和可核验来源' },
      ]}
      onCitation={vi.fn()}
    />)

    expect(screen.getByText('理解问题').closest('li')).toHaveClass('is-current')
    expect(screen.getByText('组织答案').closest('li')).not.toHaveClass('is-current')

    act(() => vi.advanceTimersByTime(600))
    expect(screen.getByText('检索资料').closest('li')).toHaveClass('is-current')

    act(() => vi.advanceTimersByTime(600))
    expect(screen.getByText('核对依据').closest('li')).toHaveClass('is-current')

    act(() => vi.advanceTimersByTime(600))
    expect(screen.getByText('组织答案').closest('li')).toHaveClass('is-current')
  })

  it('replaces the thinking indicator with a temporary streaming Markdown answer', () => {
    render(<MessageThread
      messages={[]}
      pendingQuestion="是否支持私有部署？"
      answerProgress={{ stage: 'COMPOSING', message: '正在整理结论和可核验来源' }}
      streamedAnswer={'## 结论\n\n支持私有部署。[1]'}
      onCitation={vi.fn()}
    />)

    expect(screen.getByRole('heading', { level: 2, name: '结论' })).toBeInTheDocument()
    expect(screen.getByText(/^支持私有部署/)).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('正在生成')
    expect(screen.queryByRole('button', { name: '查看处理详情' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '点赞这条回答' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '查看来源 [1]' })).not.toBeInTheDocument()
    expect(screen.getAllByText('是否支持私有部署？')).toHaveLength(1)
  })

  it('renders safe Markdown and opens an inline citation', async () => {
    const user = userEvent.setup()
    const onCitation = vi.fn()
    const content = [
      '## 部署结论',
      '',
      '支持私有部署。[1]',
      '',
      '- 先完成审批',
      '- 再准备环境',
      '',
      '| 项目 | 要求 |',
      '| --- | --- |',
      '| 网络 | 专线 |',
      '',
      '<script>window.dangerous = true</script>',
    ].join('\n')
    render(<MessageThread
      messages={[{
        ...firstMessage,
        id: 'MSG-MARKDOWN',
        role: 'ASSISTANT',
        content,
        answerStatus: 'SUPPORTED',
        citations: [citation],
      }]}
      onCitation={onCitation}
    />)

    expect(screen.getByRole('heading', { level: 2, name: '部署结论' })).toBeInTheDocument()
    expect(screen.getByRole('list')).toHaveTextContent('先完成审批')
    expect(screen.getByRole('table')).toHaveTextContent('网络专线')
    expect(document.querySelector('script')).not.toBeInTheDocument()
    expect(screen.queryByText(/window\.dangerous/)).not.toBeInTheDocument()

    const inlineCitation = screen.getByRole('button', { name: '查看来源 [1]' })
    await user.click(inlineCitation)
    expect(onCitation).toHaveBeenCalledWith(citation, inlineCitation)
  })
})
