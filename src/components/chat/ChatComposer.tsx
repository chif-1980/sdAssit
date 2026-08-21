import { Send } from 'lucide-react'

import type { AnswerMode } from '../../../shared/api/product.js'

interface ChatComposerProps {
  value: string
  mode: AnswerMode
  disabled?: boolean
  onChange: (value: string) => void
  onModeChange: (mode: AnswerMode) => void
  onSubmit: () => void
}

const modes: { value: AnswerMode; label: string; title: string }[] = [
  { value: 'CONCISE', label: '简洁', title: '快速直接回答' },
  { value: 'DETAILED', label: '详细', title: '多步查证后回答' },
]

export function ChatComposer({
  value,
  mode,
  disabled = false,
  onChange,
  onModeChange,
  onSubmit,
}: ChatComposerProps) {
  const canSubmit = !disabled && Boolean(value.trim())

  function submit() {
    if (canSubmit) onSubmit()
  }

  return (
    <form
      className="chat-composer"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <textarea
        aria-label="问题"
        placeholder="输入你的问题"
        value={value}
        rows={3}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            submit()
          }
        }}
      />
      <div className="answer-mode-switch" role="group" aria-label="回答方式">
        {modes.map((item) => (
          <button
            key={item.value}
            type="button"
            className={mode === item.value ? 'is-active' : ''}
            aria-label={`${item.label}模式`}
            aria-pressed={mode === item.value}
            title={item.title}
            disabled={disabled}
            onClick={() => onModeChange(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <button
        type="submit"
        className="primary-button composer-send"
        aria-label="发送问题"
        title="发送问题"
        disabled={!canSubmit}
      >
        <Send aria-hidden="true" size={18} />
      </button>
    </form>
  )
}
