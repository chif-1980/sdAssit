import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ClarificationCard } from './ClarificationCard'

describe('ClarificationCard', () => {
  afterEach(() => cleanup())

  it('offers generated single-choice options for legacy questions without options', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<ClarificationCard
      interrupt={{
        runId: 'RUN-1',
        status: 'INTERRUPTED',
        questionId: 'Q-1',
        question: '客户主体和商城运营主体是否已经确定？',
        type: 'TEXT',
        options: [],
        required: true,
        allowSkip: true,
      }}
      onSubmit={onSubmit}
    />)

    expect(screen.getByRole('button', { name: /已确定/ })).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: '问题回答' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /已确定/ }))
    await user.click(screen.getByRole('button', { name: '提交并继续' }))
    expect(onSubmit).toHaveBeenCalledWith('confirmed', 'answer')
  })

  it('supports selecting multiple generated options', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<ClarificationCard
      interrupt={{
        runId: 'RUN-2',
        status: 'INTERRUPTED',
        questionId: 'Q-2',
        question: '首期是否必须包含用户端、运营管理端和支付？',
        type: 'TEXT',
        options: [],
        required: true,
        allowSkip: true,
      }}
      onSubmit={onSubmit}
    />)

    await user.click(screen.getByRole('button', { name: '用户端' }))
    await user.click(screen.getByRole('button', { name: '购物车、下单和支付' }))
    await user.click(screen.getByRole('button', { name: '提交并继续' }))
    expect(onSubmit).toHaveBeenCalledWith(['user_app', 'transaction'], 'answer')
  })

  it('asks for details when the other option is selected', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<ClarificationCard
      interrupt={{
        runId: 'RUN-3',
        status: 'INTERRUPTED',
        questionId: 'Q-3',
        question: '客户主体和商城运营主体是否已经确定？',
        type: 'TEXT',
        options: [],
        required: true,
        allowSkip: true,
      }}
      onSubmit={onSubmit}
    />)

    await user.click(screen.getByRole('button', { name: /其他情况/ }))
    expect(screen.getByRole('textbox', { name: '其他说明' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '提交并继续' })).toBeDisabled()
    await user.type(screen.getByRole('textbox', { name: '其他说明' }), '客户主体尚在筹备中')
    await user.click(screen.getByRole('button', { name: '提交并继续' }))
    expect(onSubmit).toHaveBeenCalledWith('其他：客户主体尚在筹备中', 'answer')
  })

  it('canonicalizes legacy persisted labels for the主体 question', () => {
    render(<ClarificationCard
      interrupt={{
        runId: 'RUN-4',
        status: 'INTERRUPTED',
        questionId: 'Q-4',
        question: '客户主体和商城运营主体是否已经确定？',
        type: 'SINGLE_CHOICE',
        options: [
          { id: 'confirmed', label: '已确定' },
          { id: 'planning', label: '已有候选，仍需确认' },
          { id: 'undecided', label: '尚未确定' },
          { id: 'other', label: '其他' },
        ],
        required: true,
        allowSkip: true,
      }}
    />)

    expect(screen.getByRole('button', { name: /已有候选，尚未最终确认/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /其他情况/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /已有候选，仍需确认/ })).not.toBeInTheDocument()
  })

  it('renders persisted options even when an older run labels the question as text', () => {
    render(<ClarificationCard
      interrupt={{
        runId: 'RUN-5',
        status: 'INTERRUPTED',
        questionId: 'Q-5',
        question: '请选择部署方式',
        type: 'TEXT',
        options: [
          { id: 'private', label: '私有化部署' },
          { id: 'cloud', label: '公有云部署' },
        ],
        required: true,
        allowSkip: true,
      }}
    />)

    expect(screen.getByRole('button', { name: '私有化部署' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '公有云部署' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: '问题回答' })).not.toBeInTheDocument()
  })

  it('collects every question before submitting one batch answer', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<ClarificationCard
      interrupt={{
        runId: 'RUN-BATCH',
        status: 'INTERRUPTED',
        question: '首期范围是否已经确定？',
        questionId: 'SCOPE',
        questions: [
          {
            id: 'SCOPE',
            questionId: 'SCOPE',
            question: '首期范围是否已经确定？',
            type: 'SINGLE_CHOICE',
            options: [{ id: 'confirmed', label: '已确定' }],
            required: true,
            allowSkip: true,
          },
          {
            id: 'DEPLOYMENT',
            questionId: 'DEPLOYMENT',
            question: '采用哪种部署方式？',
            type: 'SINGLE_CHOICE',
            options: [{ id: 'private', label: '私有化部署' }],
            required: true,
            allowSkip: true,
          },
          {
            id: 'BUDGET',
            questionId: 'BUDGET',
            question: '预算范围是多少？',
            type: 'SINGLE_CHOICE',
            options: [{ id: 'range_a', label: '100–300 万元' }],
            required: true,
            allowSkip: true,
          },
        ],
      }}
      onSubmit={onSubmit}
    />)

    await user.click(screen.getByRole('button', { name: '已确定' }))
    await user.click(screen.getByRole('button', { name: '下一项' }))
    expect(onSubmit).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '私有化部署' }))
    await user.click(screen.getByRole('button', { name: '下一项' }))
    expect(onSubmit).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '100–300 万元' }))
    await user.click(screen.getByRole('button', { name: '提交并继续' }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith({
      SCOPE: 'confirmed',
      DEPLOYMENT: 'private',
      BUDGET: 'range_a',
    }, 'answer')
  })
})
