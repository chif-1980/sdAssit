import { FileImage, FileSpreadsheet, FileText, Paperclip, Send, X } from 'lucide-react'
import { useRef, useState } from 'react'

import type { AnswerMode } from '../../../shared/api/product.js'
import { attachmentKind, formatAttachmentSize } from './fileAttachments'

export interface ComposerAttachment {
  id: string
  file: File
  status: 'PENDING' | 'UPLOADING' | 'FAILED'
  error?: string
}

interface ChatComposerProps {
  value: string
  mode: AnswerMode
  disabled?: boolean
  attachments?: ComposerAttachment[]
  attachmentError?: string
  onChange: (value: string) => void
  onModeChange: (mode: AnswerMode) => void
  onFiles?: (files: File[]) => void
  onRemoveAttachment?: (id: string) => void
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
  attachments = [],
  attachmentError,
  onChange,
  onModeChange,
  onFiles = () => undefined,
  onRemoveAttachment = () => undefined,
  onSubmit,
}: ChatComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragActive, setDragActive] = useState(false)
  const canSubmit = !disabled && Boolean(value.trim())

  function submit() {
    if (canSubmit) onSubmit()
  }

  function acceptFiles(files: FileList | File[]) {
    if (disabled) return
    onFiles(Array.from(files))
  }

  function pastedFiles(data: DataTransfer) {
    return Array.from(data.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file))
  }

  function iconFor(file: File) {
    const kind = attachmentKind(file)
    if (kind === 'image') return <FileImage aria-hidden="true" size={15} />
    if (kind === 'spreadsheet') return <FileSpreadsheet aria-hidden="true" size={15} />
    return <FileText aria-hidden="true" size={15} />
  }

  return (
    <form
      className={`chat-composer${dragActive ? ' is-dragging' : ''}`}
      onDragOver={(event) => {
        event.preventDefault()
        if (!disabled) setDragActive(true)
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDragActive(false)
        acceptFiles(event.dataTransfer.files)
      }}
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
        onPaste={(event) => {
          const files = pastedFiles(event.clipboardData)
          if (!files.length) return
          event.preventDefault()
          acceptFiles(files)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            submit()
          }
        }}
      />
      <div className="composer-controls">
        <input
          ref={fileInputRef}
          className="composer-file-input"
          type="file"
          multiple
          accept=".doc,.docx,.xls,.xlsx,.ppt,.pptx,.pdf,.txt,.md,.markdown,.csv,.png,.jpg,.jpeg,.webp,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/pdf,text/plain,text/markdown,text/csv,image/png,image/jpeg,image/webp"
          aria-label="选择附件"
          disabled={disabled}
          onChange={(event) => {
            acceptFiles(event.target.files ?? [])
            event.currentTarget.value = ''
          }}
        />
        <button
          type="button"
          className="composer-attachment-button"
          aria-label="添加附件"
          title="添加附件"
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
        >
          <Paperclip aria-hidden="true" size={16} />
        </button>
        {attachments.length ? (
          <div className="composer-attachment-list" aria-label="已添加附件">
            {attachments.map((attachment) => (
              <div key={attachment.id} className={`composer-attachment composer-attachment-${attachment.status.toLocaleLowerCase()}`}>
                {iconFor(attachment.file)}
                <span className="composer-attachment-name" title={attachment.file.name}>{attachment.file.name}</span>
                <span className="composer-attachment-size">{attachment.status === 'UPLOADING' ? '解析中' : formatAttachmentSize(attachment.file.size)}</span>
                <button
                  type="button"
                  className="composer-attachment-remove"
                  aria-label={`移除附件 ${attachment.file.name}`}
                  title="移除附件"
                  disabled={disabled || attachment.status === 'UPLOADING'}
                  onClick={() => onRemoveAttachment(attachment.id)}
                >
                  <X aria-hidden="true" size={13} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
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
      {attachmentError ? <p className="composer-attachment-error" role="alert">{attachmentError}</p> : null}
    </form>
  )
}
