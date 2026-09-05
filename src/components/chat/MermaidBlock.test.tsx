import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ReactMarkdown from 'react-markdown'

import { mermaidMarkdownComponents } from './MermaidBlock'

const renderDiagram = vi.fn()
const initializeMermaid = vi.fn()

vi.mock('mermaid', () => ({
  default: {
    initialize: initializeMermaid,
    render: renderDiagram,
  },
}))

const source = 'flowchart TB\n  A[电话用户] --> B[软交换平台]'

function markdown(code: string) {
  return `\`\`\`mermaid\n${code}\n\`\`\``
}

describe('MermaidBlock', () => {
  afterEach(cleanup)

  beforeEach(() => {
    renderDiagram.mockReset()
    initializeMermaid.mockReset()
    renderDiagram.mockResolvedValue({ svg: '<svg data-testid="mermaid-svg"><title>流程图</title></svg>' })
  })

  it('renders a diagram by default and toggles to the original code', async () => {
    const user = userEvent.setup()
    render(<ReactMarkdown components={mermaidMarkdownComponents}>{markdown(source)}</ReactMarkdown>)

    expect(screen.getByRole('region', { name: 'Mermaid 图形' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('img', { name: 'Mermaid 图形预览' })).toBeInTheDocument())
    expect(renderDiagram).toHaveBeenCalledWith(expect.stringMatching(/^mermaid-/), source)
    expect(screen.queryByText(source)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '查看代码' }))
    expect(screen.getByText(/flowchart TB/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '查看代码' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByRole('button', { name: '查看图形' }))
    expect(screen.getByRole('img', { name: 'Mermaid 图形预览' })).toBeInTheDocument()
  })

  it('keeps the original code visible when rendering fails', async () => {
    renderDiagram.mockRejectedValueOnce(new Error('invalid syntax'))
    render(<ReactMarkdown components={mermaidMarkdownComponents}>{markdown(source)}</ReactMarkdown>)

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('无法绘制此图形'))
    expect(screen.getByRole('alert')).toHaveTextContent('已保留代码供查看')
    expect(screen.getByRole('alert')).toHaveTextContent(/flowchart TB/)
  })

  it('keeps ordinary fenced code blocks as preformatted code', () => {
    render(<ReactMarkdown components={mermaidMarkdownComponents}>{'```text\n普通代码\n```'}</ReactMarkdown>)

    expect(screen.getByText('普通代码')).toBeInTheDocument()
    expect(screen.getByText('普通代码').closest('pre')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Mermaid 图形' })).not.toBeInTheDocument()
  })
})
