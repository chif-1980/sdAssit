import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ComposerAttachment } from './ChatComposer'
import { ChatComposer } from './ChatComposer'

function ComposerHarness({
  disabled = false,
  onSubmit = vi.fn(),
  onFiles = vi.fn(),
  onRemoveAttachment = vi.fn(),
  attachments = [],
  attachmentError,
}: {
  disabled?: boolean
  onSubmit?: () => void
  onFiles?: (files: File[]) => void
  onRemoveAttachment?: (id: string) => void
  attachments?: ComposerAttachment[]
  attachmentError?: string
}) {
  const [value, setValue] = useState('')
  const [mode, setMode] = useState<'CONCISE' | 'DETAILED'>('CONCISE')
  return (
    <ChatComposer
      value={value}
      mode={mode}
      disabled={disabled}
      attachments={attachments}
      attachmentError={attachmentError}
      onChange={setValue}
      onModeChange={setMode}
      onFiles={onFiles}
      onRemoveAttachment={onRemoveAttachment}
      onSubmit={onSubmit}
    />
  )
}

afterEach(cleanup)

describe('ChatComposer', () => {
  it('exposes the question field, answer mode, and send action', () => {
    render(<ComposerHarness />)

    expect(screen.getByRole('textbox', { name: '问题' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '简洁模式' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '详细模式' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: '发送问题' })).toBeDisabled()
    expect(screen.queryByText(/上传资料|回答范围/)).not.toBeInTheDocument()
  })

  it('switches answer mode and locks the switch while disabled', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<ComposerHarness />)

    await user.click(screen.getByRole('button', { name: '详细模式' }))
    expect(screen.getByRole('button', { name: '详细模式' })).toHaveAttribute('aria-pressed', 'true')

    rerender(<ComposerHarness disabled />)
    expect(screen.getByRole('button', { name: '简洁模式' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '详细模式' })).toBeDisabled()
  })

  it('submits with Enter when the draft is not blank', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<ComposerHarness onSubmit={onSubmit} />)

    const textbox = screen.getByRole('textbox', { name: '问题' })
    await user.type(textbox, '项目上线需要什么条件？{Enter}')

    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('inserts a newline with Shift+Enter without submitting', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<ComposerHarness onSubmit={onSubmit} />)

    const textbox = screen.getByRole('textbox', { name: '问题' })
    await user.type(textbox, '第一行{Shift>}{Enter}{/Shift}第二行')

    expect(textbox).toHaveValue('第一行\n第二行')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('does not submit while Enter confirms a Chinese input method candidate', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<ComposerHarness onSubmit={onSubmit} />)

    const textbox = screen.getByRole('textbox', { name: '问题' })
    await user.type(textbox, '企业知识')
    fireEvent.keyDown(textbox, { key: 'Enter', isComposing: true })

    expect(onSubmit).not.toHaveBeenCalled()
    expect(textbox).toHaveValue('企业知识')
  })

  it('blocks editing and submission while disabled', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<ComposerHarness disabled onSubmit={onSubmit} />)

    const textbox = screen.getByRole('textbox', { name: '问题' })
    const sendButton = screen.getByRole('button', { name: '发送问题' })
    expect(textbox).toBeDisabled()
    expect(sendButton).toBeDisabled()
    expect(screen.getByRole('button', { name: '简洁模式' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '详细模式' })).toBeDisabled()

    await user.type(textbox, '不会写入')
    await user.click(sendButton)

    expect(textbox).toHaveValue('')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('opens the file picker and forwards selected files', async () => {
    const user = userEvent.setup()
    const onFiles = vi.fn()
    render(<ComposerHarness onFiles={onFiles} />)

    const file = new File(['content'], '方案.pdf', { type: 'application/pdf' })
    const input = screen.getByRole('textbox', { name: '问题' }).parentElement?.querySelector('input[type="file"]')
    expect(input).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '添加附件' }))
    await userEvent.upload(input as HTMLInputElement, file)

    expect(onFiles).toHaveBeenCalledWith([file])
  })

  it('accepts files pasted into the question field and keeps text pastes unchanged', () => {
    const onFiles = vi.fn()
    render(<ComposerHarness onFiles={onFiles} />)
    const textbox = screen.getByRole('textbox', { name: '问题' })
    const file = new File(['content'], '截图.png', { type: 'image/png' })
    const clipboardData = {
      items: [{ kind: 'file', getAsFile: () => file }],
    }

    fireEvent.paste(textbox, { clipboardData })
    expect(onFiles).toHaveBeenCalledWith([file])

    fireEvent.paste(textbox, { clipboardData: { items: [{ kind: 'string', getAsFile: () => null }] } })
    expect(onFiles).toHaveBeenCalledTimes(1)
  })

  it('accepts files dropped onto the composer', () => {
    const onFiles = vi.fn()
    render(<ComposerHarness onFiles={onFiles} />)
    const file = new File(['content'], '报价.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const composer = document.querySelector('.chat-composer') as HTMLElement

    fireEvent.drop(composer, { dataTransfer: { files: [file] } })

    expect(onFiles).toHaveBeenCalledWith([file])
  })

  it('shows attachment status and allows removing a completed attachment', async () => {
    const user = userEvent.setup()
    const onRemoveAttachment = vi.fn()
    const attachment: ComposerAttachment = {
      id: 'ATT-1',
      file: new File(['content'], '部署说明.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
      status: 'PENDING',
    }
    render(<ComposerHarness attachments={[attachment]} onRemoveAttachment={onRemoveAttachment} attachmentError="暂不支持视频或音频文件" />)

    expect(screen.getByText('部署说明.docx')).toBeInTheDocument()
    expect(screen.getByText('暂不支持视频或音频文件')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '移除附件 部署说明.docx' }))

    expect(onRemoveAttachment).toHaveBeenCalledWith('ATT-1')
  })

  it('locks attachment actions while disabled or uploading', async () => {
    const attachment: ComposerAttachment = {
      id: 'ATT-1',
      file: new File(['content'], '资料.pdf', { type: 'application/pdf' }),
      status: 'UPLOADING',
    }
    render(<ComposerHarness disabled attachments={[attachment]} />)

    expect(screen.getByRole('button', { name: '添加附件' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '移除附件 资料.pdf' })).toBeDisabled()
    expect(screen.getByText('解析中')).toBeInTheDocument()
  })
})
