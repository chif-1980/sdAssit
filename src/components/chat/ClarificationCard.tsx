import { Check, CircleHelp } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { ProductAgentInterrupt } from '../../../shared/api/product.js'

interface ClarificationCardProps {
  interrupt: ProductAgentInterrupt
  disabled?: boolean
  onSubmit?: (answer: string | string[], action: 'answer' | 'skip') => void
}

export function ClarificationCard({ interrupt, disabled = false, onSubmit }: ClarificationCardProps) {
  const [selected, setSelected] = useState<string[]>([])
  const [text, setText] = useState('')
  useEffect(() => {
    setSelected([])
    setText('')
  }, [interrupt.questionId, interrupt.question])

  const multiple = interrupt.type === 'MULTIPLE_CHOICE'
  const hasAnswer = interrupt.type === 'TEXT' ? text.trim().length > 0 : selected.length > 0
  const submit = () => {
    if (!hasAnswer || disabled) return
    onSubmit?.(interrupt.type === 'TEXT' ? text.trim() : multiple ? selected : selected[0], 'answer')
  }

  function toggleOption(id: string) {
    setSelected((current) => {
      if (multiple) return current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
      return [id]
    })
  }

  return (
    <section className="clarification-card" aria-label="待确认问题">
      <div className="clarification-card-heading">
        <span className="clarification-card-icon" aria-hidden="true"><CircleHelp size={16} /></span>
        <div>
          <strong>继续生成前，请确认一个条件</strong>
          {interrupt.position && interrupt.total ? <small>第 {interrupt.position} / {interrupt.total} 项</small> : null}
        </div>
      </div>
      <p className="clarification-card-question">{interrupt.question}</p>
      {interrupt.type === 'TEXT' || !interrupt.options?.length ? (
        <textarea
          value={text}
          rows={3}
          disabled={disabled}
          aria-label="问题回答"
          placeholder="请输入你的补充，或点击“暂不确定”"
          onChange={(event) => setText(event.target.value)}
        />
      ) : (
        <div className="clarification-card-options" role={multiple ? 'group' : 'radiogroup'} aria-label={interrupt.question}>
          {interrupt.options.map((option) => {
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
      <div className="clarification-card-actions">
        {interrupt.allowSkip !== false ? (
          <button type="button" className="clarification-skip" disabled={disabled} onClick={() => onSubmit?.('', 'skip')}>暂不确定</button>
        ) : null}
        <button type="button" className="clarification-submit" disabled={disabled || !hasAnswer} onClick={submit}>提交并继续</button>
      </div>
    </section>
  )
}
