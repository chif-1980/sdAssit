import { FileImage, FileSpreadsheet, FileText, Paperclip, Send, Square, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

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
  sending?: boolean
  onStop?: () => void
  mentions?: ComposerMention[]
  onMentionSelect?: (mention: ComposerMention) => void
  placeholder?: string
}

export interface ComposerMention {
  value: string
  label: string
  description: string
}

const modes: { value: AnswerMode; label: string; title: string }[] = [
  { value: 'CONCISE', label: '简洁', title: '快速直接回答' },
  { value: 'DETAILED', label: '详细', title: '多步查证后回答' },
]

function mentionValues(mentions: ComposerMention[]) {
  return mentions
    .map((mention) => mention.value)
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
}

function renderComposerValue(value: string, mentions: ComposerMention[], placeholder: string): ReactNode {
  if (!value) return <span className="composer-input-placeholder">{placeholder}</span>
  const values = mentionValues(mentions)
  if (!values.length) return value

  const parts: ReactNode[] = []
  let textStart = 0
  let index = 0
  while (index < value.length) {
    const matched = values.find((mention) => (
      value.startsWith(mention, index)
      && (index === 0 || /\s/u.test(value[index - 1] ?? ''))
      && (index + mention.length === value.length || /\s/u.test(value[index + mention.length] ?? ''))
    ))
    if (!matched) {
      index += 1
      continue
    }
    if (textStart < index) parts.push(value.slice(textStart, index))
    parts.push(<span key={`${index}-${matched}`} className="composer-skill-token">{matched}</span>)
    index += matched.length
    textStart = index
  }
  if (textStart < value.length) parts.push(value.slice(textStart))
  return parts
}

function removeSkillBeforeCaret(value: string, caret: number, mentions: ComposerMention[]) {
  if (caret <= 0 || caret > value.length) return null
  const values = mentionValues(mentions)
  for (const mention of values) {
    const hasTrailingSpace = value[caret - 1] === ' '
    const tokenEnd = hasTrailingSpace ? caret - 1 : caret
    const tokenStart = tokenEnd - mention.length
    if (tokenStart < 0 || value.slice(tokenStart, tokenEnd) !== mention) continue
    if (tokenStart > 0 && !/\s/u.test(value[tokenStart - 1] ?? '')) continue
    const removeEnd = !hasTrailingSpace && value[caret] === ' ' ? caret + 1 : caret
    return { value: `${value.slice(0, tokenStart)}${value.slice(removeEnd)}`, caret: tokenStart }
  }
  return null
}

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
  sending = false,
  onStop = () => undefined,
  mentions = [],
  onMentionSelect = () => undefined,
  placeholder = '输入你的问题',
}: ChatComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragActive, setDragActive] = useState(false)
  const [mentionOpen, setMentionOpen] = useState(false)
  const canSubmit = !disabled && !sending && Boolean(value.trim())

  const mentionQuery = useMemo(() => {
    const match = /(?:^|\s)@([^\s@]*)$/u.exec(value)
    return match?.[1]?.toLocaleLowerCase() ?? null
  }, [value])

  const filteredMentions = useMemo(() => {
    if (mentionQuery === null || !mentions.length) return []
    return mentions.filter((mention) => (
      mention.label.toLocaleLowerCase().includes(mentionQuery)
      || mention.value.toLocaleLowerCase().includes(mentionQuery)
    ))
  }, [mentionQuery, mentions])

  useEffect(() => {
    setMentionOpen(mentionQuery !== null && filteredMentions.length > 0 && !disabled)
  }, [disabled, filteredMentions.length, mentionQuery])

  function submit() {
    if (canSubmit) onSubmit()
  }

  function acceptFiles(files: FileList | File[]) {
    if (disabled) return
    onFiles(Array.from(files))
  }

  function selectMention(mention: ComposerMention) {
    onMentionSelect(mention)
    setMentionOpen(false)
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
      <div className="composer-input-shell">
        <div className="composer-input-visual" aria-hidden="true">
          {renderComposerValue(value, mentions, placeholder)}
        </div>
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
        <textarea
          aria-label="问题"
          placeholder={placeholder}
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
            if (event.key === 'Backspace' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
              const target = event.currentTarget
              if (target.selectionStart === target.selectionEnd) {
                const removed = removeSkillBeforeCaret(value, target.selectionStart, mentions)
                if (removed) {
                  event.preventDefault()
                  onChange(removed.value)
                  requestAnimationFrame(() => {
                    target.setSelectionRange(removed.caret, removed.caret)
                  })
                  return
                }
              }
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            }
          }}
        />
      </div>
      {mentionOpen ? (
        <div className="composer-mention-menu" role="listbox" aria-label="快捷任务">
          <div className="composer-mention-heading">可用技能</div>
          {filteredMentions.map((mention) => (
            <button
              key={mention.value}
              type="button"
              className="composer-mention-option"
              role="option"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selectMention(mention)}
            >
              <span className="composer-mention-label">{mention.value}</span>
              <span className="composer-mention-description">{mention.description}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="composer-controls">
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
        type={sending ? 'button' : 'submit'}
        className={`primary-button composer-send${sending ? ' is-stop' : ''}`}
        aria-label={sending ? '停止生成' : '发送问题'}
        title={sending ? '停止生成' : '发送问题'}
        disabled={sending ? false : !canSubmit}
        onClick={sending ? onStop : undefined}
      >
        {sending ? <Square aria-hidden="true" size={15} fill="currentColor" /> : <Send aria-hidden="true" size={18} />}
      </button>
      {attachmentError ? <p className="composer-attachment-error" role="alert">{attachmentError}</p> : null}
    </form>
  )
}
