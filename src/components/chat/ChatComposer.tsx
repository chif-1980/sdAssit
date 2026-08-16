import { Send } from 'lucide-react'

interface ChatComposerProps {
  value: string
  disabled?: boolean
  onChange: (value: string) => void
  onSubmit: () => void
}

export function ChatComposer({ value, disabled = false, onChange, onSubmit }: ChatComposerProps) {
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
