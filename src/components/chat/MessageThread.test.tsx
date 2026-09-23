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
  it('replaces a restored meeting placeholder with one live question and preserves successful results', () => {
    const assistant: ProductMessage = {
      ...firstMessage, id: 'MSG-MEETING', role: 'ASSISTANT', content: '',
      meeting: { id: 'MT-live', conversationId: 'C', state: 'running', version: 0,
        progress: { message: '读取资料' }, updatedAt: firstMessage.createdAt, sources: [] },
    }
    const view = render(<MessageThread messages={[firstMessage, assistant]}
      pendingQuestion={firstMessage.content} activeMeetingRunId="MT-live" onCitation={vi.fn()} />)
    expect(screen.getAllByText(firstMessage.content)).toHaveLength(1)
    expect(screen.queryByText('读取资料')).not.toBeInTheDocument()
    view.rerender(<MessageThread messages={[firstMessage, { ...assistant,
      meeting: { ...assistant.meeting!, result: { title: '上次纪要', meetingType: '内部', body: '保留已保存内容' } },
    }]} pendingQuestion="重新分析" activeMeetingRunId="MT-live" onCitation={vi.fn()} />)
    expect(screen.getByText('保留已保存内容')).toBeInTheDocument()
  })

  it('renders material cards only for assistant messages and routes card actions', async () => {
    const user = userEvent.setup()
    const material = {
      id: 'AST-1',
      title: '产品说明 v3.2.pdf',
      type: '产品说明',
      fileName: '产品说明 v3.2.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      updatedAt: '2026-08-28T12:00:00.000Z',
      summary: '产品定位和部署要求。',
      status: 'PUBLISHED' as const,
      approvalStatus: 'APPROVED' as const,
      publicationStatus: 'PUBLISHED' as const,
      citation,
    }
    const onPreview = vi.fn()
    const onDownload = vi.fn()
    const onDistribute = vi.fn()
    const { rerender } = render(<MessageThread
      messages={[{
        ...firstMessage,
        id: 'MSG-MATERIAL',
        role: 'ASSISTANT',
        content: '为你找到以下资料。',
        answerStatus: 'SUPPORTED',
        materials: [material],
      }]}
      onCitation={vi.fn()}
      onMaterialPreview={onPreview}
      onMaterialDownload={onDownload}
      onMaterialDistribute={onDistribute}
    />)

    expect(screen.getByRole('region', { name: '资料检索结果' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '查看摘要' }))
    await user.click(screen.getByRole('button', { name: '下载' }))
    await user.click(screen.getByRole('button', { name: '分发' }))
    expect(onPreview).toHaveBeenCalledWith(material, expect.any(HTMLButtonElement))
    expect(onDownload).toHaveBeenCalledWith(material)
    expect(onDistribute).toHaveBeenCalledWith(material)

    rerender(<MessageThread messages={[{ ...firstMessage, role: 'ASSISTANT', content: '普通回答', answerStatus: 'SUPPORTED' }]} onCitation={vi.fn()} />)
    expect(screen.queryByRole('region', { name: '资料检索结果' })).not.toBeInTheDocument()
  })

  it('labels the answer mode and offers a deep research retry for fast answers', async () => {
    const user = userEvent.setup()
    const onDeepResearch = vi.fn()
    const assistant: ProductMessage = {
      ...firstMessage,
      id: 'MSG-FAST',
      role: 'ASSISTANT',
      content: '当前已找到一条相关依据。',
      answerStatus: 'SUPPORTED',
      answerMode: 'CONCISE',
    }

    render(<MessageThread messages={[assistant]} onCitation={vi.fn()} onDeepResearch={onDeepResearch} />)

    expect(screen.getByText('快速回答')).toBeInTheDocument()
    const retry = screen.getByRole('button', { name: '重新深度查证' })
    await user.click(retry)
    expect(onDeepResearch).toHaveBeenCalledWith(assistant.content)
  })

  it('explains the longer wait while a deep research answer is running', () => {
    render(<MessageThread messages={[]} pendingQuestion="核对部署要求" pendingAnswerMode="DETAILED" onCitation={vi.fn()} />)

    expect(screen.getByText('正在进行深度查证，会比快速回答耗时更长。')).toBeInTheDocument()
  })

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
    await user.click(screen.getByRole('button', { name: '点踩这条回答' }))
    expect(screen.getByRole('dialog', { name: '选择不满意原因' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '点赞这条回答' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: '点踩这条回答' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: '提交反馈' }))
    expect(onFeedback).toHaveBeenNthCalledWith(1, 'MSG-ASSISTANT', 'LIKE')
    expect(onFeedback).toHaveBeenNthCalledWith(2, 'MSG-ASSISTANT', 'DISLIKE', 'CONTENT_ERROR', undefined)

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

  it('keeps historical rollout text without marking the now available meeting skill as planned', () => {
    render(<MessageThread
      messages={[{
        ...firstMessage,
        role: 'ASSISTANT',
        content: '「分析会议」将在第 3 阶段开放。',
        skillId: 'MEETING_ANALYSIS',
        answerStatus: 'INSUFFICIENT',
      }]}
      onCitation={vi.fn()}
    />)

    expect(screen.getByText('「分析会议」将在第 3 阶段开放。')).toBeInTheDocument()
    expect(screen.queryByText('第 3 阶段开放')).not.toBeInTheDocument()
  })

  it('keeps a material search result message visible when no material matches', () => {
    render(<MessageThread
      messages={[{
        ...firstMessage,
        role: 'ASSISTANT',
        content: '没有找到符合条件且已审核、已发布的资料。',
        skillId: 'MATERIAL_SEARCH',
        answerStatus: 'INSUFFICIENT',
      }]}
      onCitation={vi.fn()}
    />)

    expect(screen.getByText('没有找到符合条件且已审核、已发布的资料。')).toBeInTheDocument()
  })

  it('renders a structured solution draft only once instead of duplicating raw blueprint markdown', () => {
    render(<MessageThread
      messages={[{
        ...firstMessage,
        id: 'MSG-STRUCTURED-DRAFT',
        role: 'ASSISTANT',
        // Yuxi may still persist a fully rendered blueprint in `content`.
        // The structured card below is the canonical presentation.
        content: '# 方案蓝图\n这段正文不应重复展示',
        skillId: 'SOLUTION_DRAFT',
        answerStatus: 'SUPPORTED',
        solutionDraft: {
          id: 'DRAFT-STRUCTURED',
          conversationId: 'CONVERSATION-1',
          sourceRunId: 'RUN-STRUCTURED',
          currentVersion: 1,
          status: 'READY',
          title: '结构化方案',
          customerContext: '客户场景',
          executiveSummary: '结构化执行摘要',
          requirements: [],
          sections: [{ id: 'SECTION-1', title: '方案设计', contentMarkdown: '结构化正文', requirementIds: [], citationIds: [] }],
          assumptions: [],
          openQuestions: [],
          risks: [],
          conflicts: [],
          evidenceGaps: [],
          citations: [],
          quality: { status: 'READY', evidenceCoverage: 1, missingSections: [], invalidCitations: [], notes: [] },
          createdAt: '2026-08-12T00:00:00.000Z',
          updatedAt: '2026-08-12T00:00:00.000Z',
        },
      }]}
      onCitation={vi.fn()}
    />)

    expect(screen.getByText('结构化正文')).toBeInTheDocument()
    expect(screen.queryByText('这段正文不应重复展示')).not.toBeInTheDocument()
    expect(screen.getAllByLabelText('方案草稿')).toHaveLength(1)
  })

  it('keeps unresolved historical solution questions interactive without a live interrupt', async () => {
    const user = userEvent.setup()
    const onInterruptAnswer = vi.fn()
    const solutionDraft = {
      id: 'DRAFT-HISTORICAL',
      conversationId: 'CONVERSATION-1',
      sourceRunId: 'RUN-HISTORICAL',
      currentVersion: 1,
      status: 'BLOCKED' as const,
      title: '商城方案',
      customerContext: '宠物用品商城',
      executiveSummary: '待补充范围后继续生成。',
      requirements: [],
      sections: [],
      assumptions: [],
      openQuestions: [],
      risks: [],
      conflicts: [],
      evidenceGaps: [],
      citations: [],
      quality: { status: 'BLOCKED' as const, evidenceCoverage: 0, missingSections: [], invalidCitations: [], notes: [] },
      clarificationQuestions: [{
        id: 'SCOPE',
        question: '首期范围是否已经确定？',
        type: 'SINGLE_CHOICE' as const,
        options: [{ id: 'mvp', label: '已确定为 MVP' }],
        required: true,
        allowSkip: true,
        position: 1,
        total: 1,
      }],
      clarificationQuestionsResolved: false,
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
    }
    render(<MessageThread
      messages={[{
        ...firstMessage,
        id: 'MSG-HISTORICAL-DRAFT',
        role: 'ASSISTANT',
        content: '方案草稿',
        skillId: 'SOLUTION_DRAFT',
        answerStatus: 'INSUFFICIENT',
        solutionDraft,
      }]}
      onCitation={vi.fn()}
      onInterruptAnswer={onInterruptAnswer}
    />)

    const option = screen.getByRole('button', { name: '已确定为 MVP' })
    expect(option).toBeEnabled()
    await user.click(option)
    await user.click(screen.getByRole('button', { name: '提交并继续' }))
    expect(onInterruptAnswer).toHaveBeenCalledWith('mvp', 'answer')
  })

  it('derives an interactive clarification card from a legacy openQuestions field', async () => {
    const user = userEvent.setup()
    const onInterruptAnswer = vi.fn()
    render(<MessageThread
      messages={[{
        ...firstMessage,
        id: 'MSG-LEGACY-OPEN-QUESTIONS',
        role: 'ASSISTANT',
        content: '方案草稿',
        skillId: 'SOLUTION_DRAFT',
        answerStatus: 'INSUFFICIENT',
        solutionDraft: {
          id: 'DRAFT-LEGACY-OPEN-QUESTIONS',
          conversationId: 'CONVERSATION-1',
          sourceRunId: 'local-legacy-open-questions',
          currentVersion: 1,
          status: 'BLOCKED',
          title: '商城方案',
          customerContext: '宠物用品商城',
          executiveSummary: '待补充范围后继续生成。',
          requirements: [],
          sections: [],
          assumptions: [],
          openQuestions: ['方案预计采用哪种部署方式？'],
          risks: [],
          conflicts: [],
          evidenceGaps: [],
          citations: [],
          quality: { status: 'BLOCKED', evidenceCoverage: 0, missingSections: [], invalidCitations: [], notes: [] },
          clarificationQuestionsResolved: false,
          createdAt: '2026-08-12T00:00:00.000Z',
          updatedAt: '2026-08-12T00:00:00.000Z',
        },
      }]}
      onCitation={vi.fn()}
      onInterruptAnswer={onInterruptAnswer}
    />)

    expect(await screen.findByRole('button', { name: '私有化部署' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '私有化部署' }))
    await user.click(screen.getByRole('button', { name: '提交并继续' }))
    expect(onInterruptAnswer).toHaveBeenCalledWith('PRIVATE_DEPLOYMENT', 'answer')
  })

  it('derives a scope choice dialog from legacy requirements and supports other details', async () => {
    const user = userEvent.setup()
    const onInterruptAnswer = vi.fn()
    render(<MessageThread
      messages={[{
        ...firstMessage,
        id: 'MSG-LEGACY-REQUIREMENT-SCOPE',
        role: 'ASSISTANT',
        content: '方案草稿',
        skillId: 'SOLUTION_DRAFT',
        answerStatus: 'INSUFFICIENT',
        solutionDraft: {
          id: 'DRAFT-LEGACY-REQUIREMENT-SCOPE',
          conversationId: 'CONVERSATION-1',
          sourceRunId: 'RUN-LEGACY-REQUIREMENT-SCOPE',
          currentVersion: 1,
          status: 'BLOCKED',
          title: '宠物用品商城方案',
          customerContext: '建设宠物用品电子商城',
          executiveSummary: '待确认首期范围后继续生成。',
          requirements: [{
            id: 'REQ-SCOPE',
            text: '建议纳入首期范围：微信小程序首页、商品分类、商品搜索和商品详情；购物车、下单和支付。',
            source: '需求分析，待确认',
          }],
          sections: [],
          assumptions: [],
          openQuestions: [],
          risks: [],
          conflicts: [],
          evidenceGaps: [],
          citations: [],
          quality: { status: 'BLOCKED', evidenceCoverage: 0, missingSections: [], invalidCitations: [], notes: [] },
          clarificationQuestionsResolved: false,
          createdAt: '2026-08-12T00:00:00.000Z',
          updatedAt: '2026-08-12T00:00:00.000Z',
        },
      }]}
      onCitation={vi.fn()}
      onInterruptAnswer={onInterruptAnswer}
    />)

    expect(screen.getByText('待确认问题')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '微信小程序首页、商品分类、商品搜索和商品详情' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '购物车、下单和支付。' })).toBeInTheDocument()
    const other = screen.getByRole('button', { name: '其他（请说明）' })
    await user.click(other)
    const detail = screen.getByRole('textbox', { name: '其他说明' })
    await user.type(detail, '还需要会员积分')
    await user.click(screen.getByRole('button', { name: '提交并继续' }))
    expect(onInterruptAnswer).toHaveBeenCalledWith(['其他：还需要会员积分'], 'answer')
  })

  it('does not re-ask a product-form requirement already stated in the customer context', () => {
    render(<MessageThread
      messages={[{
        ...firstMessage,
        id: 'MSG-LEGACY-REQUIREMENT-FORM-ANSWERED',
        role: 'ASSISTANT',
        content: '方案草稿',
        skillId: 'SOLUTION_DRAFT',
        answerStatus: 'INSUFFICIENT',
        solutionDraft: {
          id: 'DRAFT-LEGACY-REQUIREMENT-FORM-ANSWERED',
          conversationId: 'CONVERSATION-1',
          sourceRunId: 'RUN-LEGACY-REQUIREMENT-FORM-ANSWERED',
          currentVersion: 1,
          status: 'BLOCKED',
          title: '宠物用品商城方案',
          customerContext: '客户已经明确建设微信小程序商城',
          executiveSummary: '待补充范围后继续生成。',
          requirements: [{ id: 'REQ-FORM', text: '明确是否建设微信小程序用户端', source: '产品形态推断，待确认' }],
          sections: [],
          assumptions: [],
          openQuestions: [],
          risks: [],
          conflicts: [],
          evidenceGaps: [],
          citations: [],
          quality: { status: 'BLOCKED', evidenceCoverage: 0, missingSections: [], invalidCitations: [], notes: [] },
          clarificationQuestionsResolved: false,
          createdAt: '2026-08-12T00:00:00.000Z',
          updatedAt: '2026-08-12T00:00:00.000Z',
        },
      }]}
      onCitation={vi.fn()}
      onInterruptAnswer={vi.fn()}
    />)

    expect(screen.queryByText('待确认问题')).not.toBeInTheDocument()
  })

  it('explains when a legacy clarification has no resumable run instead of silently doing nothing', () => {
    const onInterruptAnswer = vi.fn()
    render(<MessageThread
      messages={[{
        ...firstMessage,
        id: 'MSG-LEGACY-NO-RUN',
        role: 'ASSISTANT',
        content: '方案草稿',
        skillId: 'SOLUTION_DRAFT',
        answerStatus: 'INSUFFICIENT',
        solutionDraft: {
          id: 'DRAFT-LEGACY-NO-RUN',
          conversationId: 'CONVERSATION-1',
          currentVersion: 1,
          status: 'BLOCKED',
          title: '商城方案',
          customerContext: '宠物用品商城',
          executiveSummary: '待补充范围后继续生成。',
          requirements: [],
          sections: [],
          assumptions: [],
          openQuestions: ['方案预计采用哪种部署方式？'],
          risks: [],
          conflicts: [],
          evidenceGaps: [],
          citations: [],
          quality: { status: 'BLOCKED', evidenceCoverage: 0, missingSections: [], invalidCitations: [], notes: [] },
          clarificationQuestionsResolved: false,
          createdAt: '2026-08-12T00:00:00.000Z',
          updatedAt: '2026-08-12T00:00:00.000Z',
        },
      }]}
      onCitation={vi.fn()}
      onInterruptAnswer={onInterruptAnswer}
    />)

    expect(screen.getByText('该方案运行已失效，暂时无法提交待确认内容。请重新生成方案后继续。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '私有化部署' })).not.toBeInTheDocument()
    expect(onInterruptAnswer).not.toHaveBeenCalled()
  })

  it('does not duplicate draft questions while a live interrupt is displayed', () => {
    const solutionDraft = {
      id: 'DRAFT-LIVE',
      conversationId: 'CONVERSATION-1',
      sourceRunId: 'RUN-LIVE',
      currentVersion: 1,
      status: 'BLOCKED' as const,
      title: '商城方案',
      customerContext: '宠物用品商城',
      executiveSummary: '待补充范围后继续生成。',
      requirements: [],
      sections: [],
      assumptions: [],
      openQuestions: [],
      risks: [],
      conflicts: [],
      evidenceGaps: [],
      citations: [],
      quality: { status: 'BLOCKED' as const, evidenceCoverage: 0, missingSections: [], invalidCitations: [], notes: [] },
      clarificationQuestions: [{
        id: 'SCOPE',
        question: '首期范围是否已经确定？',
        type: 'SINGLE_CHOICE' as const,
        options: [{ id: 'mvp', label: '已确定为 MVP' }],
        required: true,
        allowSkip: true,
        position: 1,
        total: 1,
      }],
      clarificationQuestionsResolved: false,
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
    }
    render(<MessageThread
      messages={[{
        ...firstMessage,
        id: 'MSG-LIVE-DRAFT',
        role: 'ASSISTANT',
        content: '方案草稿',
        skillId: 'SOLUTION_DRAFT',
        answerStatus: 'INSUFFICIENT',
        solutionDraft,
      }]}
      pendingQuestion="请补充首期范围"
      agentInterruptQuestion={{
        runId: 'RUN-LIVE',
        status: 'INTERRUPTED',
        questionId: 'SCOPE',
        question: '首期范围是否已经确定？',
        type: 'SINGLE_CHOICE',
        options: [{ id: 'mvp', label: '已确定为 MVP' }],
        required: true,
        allowSkip: true,
      }}
      onCitation={vi.fn()}
      onInterruptAnswer={vi.fn()}
    />)

    expect(screen.getAllByRole('button', { name: '已确定为 MVP' })).toHaveLength(1)
    expect(screen.getAllByLabelText('待确认问题')).toHaveLength(1)
  })

  it('keeps an interactive question out of the separate 待补充 list', () => {
    render(<MessageThread
      messages={[{
        ...firstMessage,
        id: 'MSG-DUPLICATE-OPEN-QUESTION',
        role: 'ASSISTANT',
        content: '方案草稿',
        skillId: 'SOLUTION_DRAFT',
        answerStatus: 'INSUFFICIENT',
        solutionDraft: {
          id: 'DRAFT-DUPLICATE-OPEN-QUESTION',
          conversationId: 'CONVERSATION-1',
          sourceRunId: 'RUN-DUPLICATE-OPEN-QUESTION',
          currentVersion: 1,
          status: 'BLOCKED',
          title: '商城方案',
          customerContext: '宠物用品商城',
          executiveSummary: '待补充范围后继续生成。',
          requirements: [],
          sections: [],
          assumptions: [],
          openQuestions: ['方案预计采用哪种部署方式？'],
          risks: [],
          conflicts: [],
          evidenceGaps: [],
          citations: [],
          clarificationQuestions: [{
            id: 'DEPLOYMENT_MODE',
            question: '方案预计采用哪种部署方式？',
            type: 'SINGLE_CHOICE',
            options: [{ id: 'PRIVATE_DEPLOYMENT', label: '私有化部署' }],
            required: true,
            allowSkip: true,
            position: 1,
            total: 1,
          }],
          clarificationQuestionsResolved: false,
          quality: { status: 'BLOCKED', evidenceCoverage: 0, missingSections: [], invalidCitations: [], notes: [] },
          createdAt: '2026-08-12T00:00:00.000Z',
          updatedAt: '2026-08-12T00:00:00.000Z',
        },
      }]}
      onCitation={vi.fn()}
      onInterruptAnswer={vi.fn()}
    />)

    expect(screen.getByText('待确认问题')).toBeInTheDocument()
    expect(screen.queryByText('待补充')).not.toBeInTheDocument()
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
    const status = screen.getByRole('status', { name: '执行过程' })
    expect(status).not.toHaveTextContent('部署前需要准备什么？')
    expect(status.querySelector('.thinking-summary-copy strong')).toHaveTextContent('理解问题')
    expect(within(status).queryByText('检索资料')).not.toBeInTheDocument()
    expect(within(status).queryByText('核对依据')).not.toBeInTheDocument()
    expect(within(status).queryByText('组织答案')).not.toBeInTheDocument()
    const toggle = screen.getByRole('button', { name: '查看执行过程' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByText('正在结合当前对话理解问题')).toHaveLength(2)
    expect(screen.getByText('执行过程会随 Agent 的实际动作更新，不会预先展示未执行的阶段。')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '收起执行过程' }))
    expect(screen.getByRole('button', { name: '查看执行过程' })).toHaveAttribute('aria-expanded', 'false')
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
    expect(document.querySelector('.thinking-step')?.textContent).toContain('检索资料')
    expect(document.querySelector('.thinking-step')?.textContent).not.toContain('组织答案')

    rerender(<MessageThread
      messages={[]}
      pendingQuestion="查一下部署要求"
      answerProgress={{ stage: 'COMPOSING', message: '正在整理结论和可核验来源' }}
      onCitation={vi.fn()}
    />)
    expect(document.querySelector('.thinking-step')?.textContent).toContain('组织答案')
    expect(document.querySelector('.thinking-summary-copy > span')).toHaveTextContent('正在整理结论和可核验来源')

    act(() => vi.advanceTimersByTime(4_000))
    act(() => screen.getByRole('button', { name: '查看执行过程' }).click())
    expect(screen.getByText('资料较多，正在逐条核对来源；处理进度会持续更新。')).toBeInTheDocument()
  })

  it('stops timing and preserves the preview and execution steps after failure', () => {
    vi.useFakeTimers()
    const props = {
      messages: [], pendingQuestion: '设计方案', streamedAnswer: '已生成的方案片段', onCitation: vi.fn(),
      answerProgressTrail: [{ stage: 'REQUIREMENTS_ANALYSIS' as const, message: '需求已拆解', status: 'COMPLETED' }],
    }
    const { rerender } = render(<MessageThread {...props} answerProgress={{ stage: 'COMPOSING', message: '正在整理方案', status: 'ACTIVE' }} />)
    act(() => vi.advanceTimersByTime(5_000))
    rerender(<MessageThread {...props} answerProgress={{ stage: 'COMPOSING', message: '正在整理方案', status: 'FAILED' }} />)
    const elapsed = document.querySelector('.thinking-elapsed')?.textContent
    act(() => vi.advanceTimersByTime(10_000))

    expect(document.querySelector('.thinking-elapsed')?.textContent).toBe(elapsed)
    expect(document.querySelector('.thinking-spinner')).toBeNull()
    expect(screen.getByText('生成失败')).toBeInTheDocument()
    expect(screen.getByText('已生成的方案片段')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('未完成的方案预览')
    expect(document.querySelectorAll('.thinking-step')).toHaveLength(2)
    expect(document.querySelector('.thinking-hint')).toBeNull()
  })

  it('renders the actual action order when the agent returns to retrieval', () => {
    render(<MessageThread
      messages={[]}
      pendingQuestion="查一下部署要求"
      answerProgress={{ stage: 'COMPOSING', message: '正在整理结论和可核验来源' }}
      answerProgressTrail={[
        { stage: 'UNDERSTANDING', message: '正在结合当前对话理解问题' },
        { stage: 'RETRIEVING', message: '正在检索已审核发布的资料' },
        { stage: 'VERIFYING', message: '正在核对原文与适用条件' },
        { stage: 'RETRIEVING', message: '核验后正在补充检索资料' },
        { stage: 'COMPOSING', message: '正在整理结论和可核验来源' },
      ]}
      onCitation={vi.fn()}
    />)

    const steps = [...document.querySelectorAll('.thinking-step')]
    expect(steps.map((step) => step.querySelector('strong')?.textContent)).toEqual([
      '理解问题', '检索资料', '核对依据', '检索资料', '组织答案',
    ])
    expect(steps.find((step) => step.textContent?.includes('组织答案'))).toHaveClass('is-current')
    expect(steps.find((step) => step.textContent?.includes('理解问题'))).toHaveClass('is-complete')
    expect(steps.filter((step) => step.textContent?.includes('检索资料'))).toHaveLength(2)
    expect(steps.find((step) => step.textContent?.includes('核对依据'))).toHaveClass('is-complete')
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
    expect(screen.getByRole('button', { name: '查看执行过程' })).toBeInTheDocument()
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
