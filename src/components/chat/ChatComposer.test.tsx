import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ChatComposer } from './ChatComposer'

function ComposerHarness({ disabled = false, onSubmit = vi.fn() }: { disabled?: boolean; onSubmit?: () => void }) {
  const [value, setValue] = useState('')
  return (
    <ChatComposer
      value={value}
      disabled={disabled}
      onChange={setValue}
      onSubmit={onSubmit}
    />
  )
}

afterEach(cleanup)

describe('ChatComposer', () => {
  it('only exposes the question field and send action', () => {
    render(<ComposerHarness />)

    expect(screen.getByRole('textbox', { name: '问题' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '发送问题' })).toBeDisabled()
    expect(screen.queryByText(/上传资料|回答范围/)).not.toBeInTheDocument()
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

    await user.type(textbox, '不会写入')
    await user.click(sendButton)

    expect(textbox).toHaveValue('')
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
