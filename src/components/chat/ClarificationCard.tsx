import { Check, CircleHelp } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type { ProductAgentInterrupt } from '../../../shared/api/product.js'

export type ClarificationAnswer = string | string[] | Record<string, string | string[]>

interface ClarificationCardProps {
  interrupt: ProductAgentInterrupt
  disabled?: boolean
  onSubmit?: (answer: ClarificationAnswer, action: 'answer' | 'skip') => void
}

export function enrichClarificationQuestion<T extends { question: string; type?: 'SINGLE_CHOICE' | 'MULTIPLE_CHOICE' | 'TEXT'; options?: { id: string; label: string; description?: string }[] }>(question: T): T {
  const text = question.question
  // Customer/operating主体 questions used to be persisted with the vague
  // labels “已有候选，仍需确认”和“其他”.  Canonicalize this known question
  // even when an old payload already contains options, so historical drafts
  // get the same unambiguous choices as new runs.
  if (text.includes('客户主体') || text.includes('运营主体')) {
    return {
      ...question,
      type: 'SINGLE_CHOICE',
      options: [
        { id: 'confirmed', label: '已确定', description: '客户主体和运营主体都已明确，可以按此继续设计。' },
        { id: 'planning', label: '已有候选，尚未最终确认', description: '已有具体候选主体，但还没有完成最终决策。' },
        { id: 'undecided', label: '尚未确定', description: '目前还没有可供确认的候选主体。' },
        { id: 'other', label: '其他情况', description: '不属于以上三种情况，请补充说明。' },
      ],
    } as T
  }
  if (question.options?.length) {
    // Some older Agent runs persisted a TEXT type together with usable
    // options. Prefer the concrete choices so the UI never hides them behind
    // a free-form textarea.
    return {
      ...question,
      type: question.type === 'MULTIPLE_CHOICE' ? 'MULTIPLE_CHOICE' : 'SINGLE_CHOICE',
    } as T
  }
  let type = question.type
  let options: { id: string; label: string; description?: string }[] = []
  if (text.includes('运营模式') || text.includes('经营模式') || text.includes('商城模式')) {
    type = 'SINGLE_CHOICE'
    options = [
      { id: 'self_operated', label: '自营' },
      { id: 'platform', label: '平台入驻 / 多商户' },
      { id: 'distribution', label: '分销' },
      { id: 'store_delivery', label: '门店配送' },
      { id: 'mixed', label: '自营 + 平台入驻混合' },
      { id: 'other', label: '其他（请说明）' },
    ]
  } else if (text.includes('销售哪些') || text.includes('售卖哪些') || text.includes('商品类型') || text.includes('商品品类') || text.includes('宠物用品')) {
    type = 'MULTIPLE_CHOICE'
    options = [
      { id: 'food', label: '宠物食品' },
      { id: 'supplies', label: '宠物用品（牵引、清洁、窝垫等）' },
      { id: 'toys', label: '宠物玩具' },
      { id: 'health', label: '宠物保健与护理用品' },
      { id: 'clothing', label: '宠物服饰' },
      { id: 'other', label: '其他（请说明）' },
    ]
  } else if (text.includes('部署') || text.includes('私有化') || text.includes('公有云') || text.includes('混合部署') || text.includes('云上')) {
    // Keep legacy display-only questions aligned with the server's canonical
    // deployment dimension.  A plain open question from an older run should
    // still offer the same choices as a newly generated interrupt.
    type = 'SINGLE_CHOICE'
    options = [
      { id: 'PRIVATE_DEPLOYMENT', label: '私有化部署' },
      { id: 'HYBRID_DEPLOYMENT', label: '混合部署' },
      { id: 'PUBLIC_CLOUD', label: '公有云部署' },
      { id: 'OTHER', label: '其他（请说明）' },
    ]
  } else if (text.includes('上线时间') || text.includes('交付时间') || text.includes('何时上线')) {
    type = 'SINGLE_CHOICE'
    options = [
      { id: 'one_month', label: '1 个月内上线' },
      { id: 'one_to_three_months', label: '1–3 个月内上线' },
      { id: 'three_to_six_months', label: '3–6 个月内上线' },
      { id: 'not_set', label: '尚未确定时间' },
      { id: 'other', label: '其他（请说明）' },
    ]
  } else if (text.includes('预算') || text.includes('投资金额') || text.includes('投入范围')) {
    type = 'SINGLE_CHOICE'
    options = [
      { id: 'under_100k', label: '10 万元以内' },
      { id: '100k_to_300k', label: '10–30 万元' },
      { id: '300k_to_1m', label: '30–100 万元' },
      { id: 'over_1m', label: '100 万元以上' },
      { id: 'not_set', label: '尚未确定预算' },
      { id: 'other', label: '其他（请说明）' },
    ]
  } else if ((text.includes('物流') || text.includes('退款') || text.includes('售后') || text.includes('履约') || text.includes('配送')) && (text.includes('需要') || text.includes('支持') || text.includes('是否') || text.includes('包含'))) {
    type = 'MULTIPLE_CHOICE'
    options = [
      { id: 'logistics', label: '物流与配送' },
      { id: 'refund', label: '退款与售后' },
      { id: 'after_sales', label: '客服与售后处理' },
      { id: 'none', label: '首期暂不支持' },
      { id: 'other', label: '其他（请说明）' },
    ]
  } else if ((text.includes('首期') || text.includes('必须包含')) && (text.includes('范围') || text.includes('功能') || text.includes('模块') || text.includes('端') || text.includes('建设'))) {
    type = 'MULTIPLE_CHOICE'
    options = [
      { id: 'user_app', label: '用户端' },
      { id: 'admin', label: '运营管理端' },
      { id: 'catalog', label: '商品管理与上下架' },
      { id: 'transaction', label: '购物车、下单和支付' },
      { id: 'undecided', label: '暂未确定首期范围' },
    ]
  } else if (text.includes('SKU') || text.includes('商品数量')) {
    type = 'SINGLE_CHOICE'
    options = [
      { id: 'small', label: '少于 100 个 SKU' },
      { id: 'medium', label: '100–1000 个 SKU' },
      { id: 'large', label: '超过 1000 个 SKU' },
      { id: 'undecided', label: '暂未确定' },
    ]
  } else if (text.includes('ERP') || text.includes('库存') || text.includes('物流') || text.includes('客服')) {
    type = 'MULTIPLE_CHOICE'
    options = [
      { id: 'erp', label: 'ERP / 业务系统' },
      { id: 'inventory', label: '库存系统' },
      { id: 'logistics', label: '物流 / 配送系统' },
      { id: 'service', label: '客服 / 会员系统' },
      { id: 'none', label: '暂无系统需要对接' },
    ]
  } else if (text.includes('退款') || text.includes('优惠券') || text.includes('会员') || text.includes('营销')) {
    type = 'MULTIPLE_CHOICE'
    options = [
      { id: 'refund', label: '退款与售后' },
      { id: 'coupon', label: '优惠券 / 促销' },
      { id: 'membership', label: '会员 / 积分' },
      { id: 'group_buy', label: '拼团 / 秒杀' },
      { id: 'undecided', label: '暂未确定' },
    ]
  } else {
    // Do not present generic confirmation states as if they were answers to
    // the question.  When no domain-specific option can be inferred, keep a
    // free-form field so the Agent can ask a focused follow-up next time.
    type = 'TEXT'
    options = []
  }
  return { ...question, type, options } as T
}

type NormalizedClarification = ProductAgentInterrupt & {
  id: string
  questionId: string
  question: string
  type: NonNullable<ProductAgentInterrupt['type']>
  options: NonNullable<ProductAgentInterrupt['options']>
  required: boolean
  allowSkip: boolean
  position: number
  total: number
}

type InterruptQuestionInput = NonNullable<ProductAgentInterrupt['questions']>[number] & {
  question: string
}

/**
 * Normalize the two interrupt shapes emitted by the runtime.  Older runs
 * contain one question at the top level, while newer LangGraph interrupts
 * can carry a batch in `questions`.  Keeping this helper here means the
 * card, the draft card and the page all render the same deterministic list.
 */
export function clarificationQuestionsForInterrupt(interrupt: ProductAgentInterrupt): NormalizedClarification[] {
  const rawQuestions: InterruptQuestionInput[] = interrupt.questions?.length
    ? interrupt.questions
    : [interrupt as InterruptQuestionInput]
  const seenIds = new Set<string>()
  const seenTexts = new Set<string>()
  const normalized: NormalizedClarification[] = []
  rawQuestions.forEach((rawQuestion, index) => {
    const question = enrichClarificationQuestion({
      ...interrupt,
      ...rawQuestion,
      questionId: rawQuestion.questionId ?? rawQuestion.id ?? interrupt.questionId ?? `question-${index + 1}`,
      runId: interrupt.runId,
      status: 'INTERRUPTED' as const,
    }) as ProductAgentInterrupt
    const id = String(question.questionId ?? rawQuestion.id ?? `question-${index + 1}`).trim()
    const text = question.question.trim()
    if (!text) return
    const normalizedText = text.replace(/\s+/gu, ' ')
    if (seenIds.has(id) || seenTexts.has(normalizedText)) return
    seenIds.add(id)
    seenTexts.add(normalizedText)
    normalized.push({
      ...question,
      id,
      questionId: id,
      type: question.type ?? 'TEXT',
      options: question.options ?? [],
      required: question.required !== false,
      allowSkip: question.allowSkip !== false,
      position: index + 1,
      total: rawQuestions.length,
    })
  })
  return normalized.map((question, index, all) => ({
    ...question,
    position: index + 1,
    total: all.length,
  }))
}

function isOtherOption(option: { id: string; label: string }) {
  return option.id.toLocaleLowerCase() === 'other' || /其他/u.test(option.label)
}

const SKIPPED_ANSWER = '（用户暂不确定）'

export function ClarificationCard({ interrupt, disabled = false, onSubmit }: ClarificationCardProps) {
  const questions = useMemo(() => clarificationQuestionsForInterrupt(interrupt), [interrupt])
  const questionSignature = questions.map((question) => `${question.questionId}:${question.question}`).join('|')
  const [currentIndex, setCurrentIndex] = useState(0)
  const [selectedByQuestion, setSelectedByQuestion] = useState<Record<string, string[]>>({})
  const [detailByQuestion, setDetailByQuestion] = useState<Record<string, string>>({})
  const [answersByQuestion, setAnswersByQuestion] = useState<Record<string, string | string[]>>({})
  const [skippedQuestions, setSkippedQuestions] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    setCurrentIndex(0)
    setSelectedByQuestion({})
    setDetailByQuestion({})
    setAnswersByQuestion({})
    setSkippedQuestions(new Set())
  }, [questionSignature])

  const current = questions[currentIndex]
  if (!current) return null
  const selected = selectedByQuestion[current.questionId] ?? []
  const text = detailByQuestion[current.questionId] ?? ''
  const multiple = current.type === 'MULTIPLE_CHOICE'
  const selectedOther = current.options.find((option) => selected.includes(option.id) && isOtherOption(option))
  const needsOtherDetail = Boolean(selectedOther)
  const hasAnswer = current.type === 'TEXT'
    ? text.trim().length > 0
    : selected.length > 0 && (!needsOtherDetail || text.trim().length > 0)
  const isLast = currentIndex === questions.length - 1

  function answerValue(question: NormalizedClarification, selectedValues: string[], detail: string): string | string[] {
    if (question.type === 'TEXT') return detail.trim()
    const other = question.options.find((option) => selectedValues.includes(option.id) && isOtherOption(option))
    if (other && detail.trim()) {
      return question.type === 'MULTIPLE_CHOICE'
        ? [...selectedValues.filter((item) => item !== other.id), `其他：${detail.trim()}`]
        : `其他：${detail.trim()}`
    }
    return question.type === 'MULTIPLE_CHOICE' ? selectedValues : selectedValues[0] ?? ''
  }

  function submitAll(nextAnswers: Record<string, string | string[]>, nextSkipped: Set<string>) {
    if (!onSubmit || disabled) return
    const payload: Record<string, string | string[]> = { ...nextAnswers }
    nextSkipped.forEach((questionId) => { payload[questionId] = SKIPPED_ANSWER })
    // A one-question legacy interrupt keeps its original callback contract;
    // multi-question interrupts are submitted as one map only after the last
    // item, so the Agent never resumes with a partial decision set.
    if (questions.length === 1 && nextSkipped.has(current.questionId)) {
      onSubmit('', 'skip')
      return
    }
    if (questions.length === 1) {
      onSubmit(payload[current.questionId] ?? '', 'answer')
      return
    }
    onSubmit(payload, 'answer')
  }

  function commitCurrent(skip = false) {
    if (disabled) return
    if (!skip && !hasAnswer) return
    const questionId = current.questionId
    const nextAnswers = { ...answersByQuestion }
    const nextSkipped = new Set(skippedQuestions)
    if (skip) {
      delete nextAnswers[questionId]
      nextSkipped.add(questionId)
    } else {
      nextSkipped.delete(questionId)
      nextAnswers[questionId] = answerValue(current, selected, text)
    }
    setAnswersByQuestion(nextAnswers)
    setSkippedQuestions(nextSkipped)
    if (isLast) {
      submitAll(nextAnswers, nextSkipped)
      return
    }
    setCurrentIndex((index) => index + 1)
  }

  function toggleOption(id: string) {
    setSelectedByQuestion((currentValues) => {
      const currentSelected = currentValues[current.questionId] ?? []
      const nextSelected = multiple
        ? currentSelected.includes(id) ? currentSelected.filter((item) => item !== id) : [...currentSelected, id]
        : [id]
      return { ...currentValues, [current.questionId]: nextSelected }
    })
  }

  return (
    <section className="clarification-card" aria-label="待确认问题">
      <div className="clarification-card-heading">
        <span className="clarification-card-icon" aria-hidden="true"><CircleHelp size={16} /></span>
        <div>
          <strong>继续生成前，请确认方案条件</strong>
          <small>第 {current.position} / {current.total} 项</small>
        </div>
      </div>
      <p className="clarification-card-question">{current.question}</p>
      {current.options.length === 0 ? (
        <textarea
          value={text}
          rows={3}
          disabled={disabled}
          aria-label="问题回答"
          placeholder="请输入你的补充，或点击“暂不确定”"
          onChange={(event) => setDetailByQuestion((values) => ({ ...values, [current.questionId]: event.target.value }))}
        />
      ) : (
        <div className="clarification-card-options" role={multiple ? 'group' : 'radiogroup'} aria-label={current.question}>
          {current.options.map((option) => {
            const checked = selected.includes(option.id)
            return (
              <button
                key={option.id}
                type="button"
                className={`clarification-option${checked ? ' is-selected' : ''}`}
                disabled={disabled}
                aria-pressed={checked}
                onClick={() => toggleOption(option.id)}
              >
                <span className="clarification-option-check" aria-hidden="true">{checked ? <Check size={13} /> : null}</span>
                <span><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</span>
              </button>
            )
          })}
        </div>
      )}
      {current.type !== 'TEXT' && needsOtherDetail ? (
        <textarea
          value={text}
          rows={2}
          disabled={disabled}
          aria-label="其他说明"
          placeholder="请补充说明"
          onChange={(event) => setDetailByQuestion((values) => ({ ...values, [current.questionId]: event.target.value }))}
        />
      ) : null}
      <div className="clarification-card-actions">
        {current.allowSkip !== false ? (
          <button type="button" className="clarification-skip" disabled={disabled} onClick={() => commitCurrent(true)}>暂不确定</button>
        ) : null}
        <button type="button" className="clarification-submit" disabled={disabled || !hasAnswer} onClick={() => commitCurrent(false)}>
          {isLast ? '提交并继续' : '下一项'}
        </button>
      </div>
    </section>
  )
}
