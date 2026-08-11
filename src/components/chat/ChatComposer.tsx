import { FileText, Paperclip, Send } from 'lucide-react'

import type { ConversationScope } from '../../../shared/domain/enums.js'

interface ChatComposerProps {
  value: string
  scope: ConversationScope
  disabled?: boolean
  attachments?: Array<{
    id: string
    label: string
    status: 'processing' | 'ready' | 'failed' | 'expired'
    error?: string
  }>
  onChange: (value: string) => void
  onScopeChange: (scope: ConversationScope) => void
  onSubmit: () => void
  onFile: (file: File) => void
}

const scopeLabels: Record<ConversationScope, string> = {
  ENTERPRISE: '企业知识',
  SESSION: '本次会话资料',
  BOTH: '企业知识 + 会话资料',
}

export function ChatComposer({
  value,
  scope,
  disabled = false,
  attachments = [],
  onChange,
  onScopeChange,
  onSubmit,
  onFile,
}: ChatComposerProps) {
  return (
    <form
      className="chat-composer"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <textarea
        aria-label="问题"
        placeholder="输入你的问题"
        value={value}
        rows={3}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      {attachments.length ? (
        <ul className="attachment-list" aria-label="会话资料">
          {attachments.map((attachment) => (
            <li key={attachment.id} className={`attachment-status attachment-${attachment.status}`}>
              <FileText aria-hidden="true" size={14} />
              <span>{attachment.label}</span>
              <small>{attachment.status === 'processing' ? '处理中' : attachment.status === 'failed' ? attachment.error ?? '处理失败' : attachment.status === 'expired' ? '已过期' : '已就绪'}</small>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="composer-toolbar">
        <label className="scope-control">
          <span>回答范围</span>
          <select
            aria-label="回答范围"
            value={scope}
            disabled={disabled}
            onChange={(event) => onScopeChange(event.target.value as ConversationScope)}
          >
            {(Object.keys(scopeLabels) as ConversationScope[]).map((item) => (
              <option key={item} value={item}>{scopeLabels[item]}</option>
            ))}
          </select>
        </label>
        <label className="attachment-button secondary-button">
          <Paperclip aria-hidden="true" size={16} />
          <span>上传资料</span>
          <input
            aria-label="上传文本资料"
            type="file"
            accept=".txt,.md,.markdown,text/plain,text/markdown"
            disabled={disabled}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) onFile(file)
              event.currentTarget.value = ''
            }}
          />
        </label>
        <button type="submit" className="primary-button" disabled={disabled || !value.trim()}>
          <Send aria-hidden="true" size={16} />
          发送
        </button>
      </div>
    </form>
  )
}
