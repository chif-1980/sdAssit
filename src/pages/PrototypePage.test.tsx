import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PrototypePage } from './PrototypePage'

vi.mock('../session/SessionProvider', () => ({
  useSession: () => ({
    user: { id: 'USR-1', name: '陈晨', avatarUrl: null },
    status: 'authenticated',
    logout: vi.fn(async () => undefined),
    reload: vi.fn(),
  }),
}))

afterEach(cleanup)

describe('PrototypePage business workbench', () => {
  it('invokes the material skill and exposes the three material actions', async () => {
    const user = userEvent.setup()
    render(<PrototypePage />)

    expect(screen.getByRole('heading', { name: /让每一次工作协作/u })).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: /查资料/u })[0])

    expect(screen.getByText('找到 3 份可用资料')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '查看摘要' })).toHaveLength(3)
    expect(screen.getAllByRole('button', { name: '下载' })).toHaveLength(3)
    expect(screen.getAllByRole('button', { name: '分发' })).toHaveLength(3)

    await user.click(screen.getAllByRole('button', { name: '分发' })[0])
    expect(screen.getByRole('dialog', { name: /分发/u })).toHaveTextContent('手机端优先')
    expect(screen.getByRole('dialog', { name: /分发/u })).toHaveTextContent('系统分享')

    await user.click(screen.getByRole('button', { name: /飞书调用飞书分享入口/u }))
    expect(screen.getAllByRole('status').some((item) => item.textContent?.includes('已调用飞书分发入口'))).toBe(true)
  })

  it('offers an internal meeting example without requiring a customer or project', async () => {
    const user = userEvent.setup()
    render(<PrototypePage />)

    await user.click(screen.getAllByRole('button', { name: /分析会议/u })[0])

    expect(screen.getByText('内部产品讨论')).toBeInTheDocument()
    expect(screen.getByText('未关联客户')).toBeInTheDocument()
    expect(screen.getByText('未关联项目')).toBeInTheDocument()
    expect(screen.getByText(/客户和项目均为可选信息/u)).toBeInTheDocument()
  })

  it('opens the @ skill menu and switches to the selected skill context', async () => {
    const user = userEvent.setup()
    render(<PrototypePage />)

    const textbox = screen.getByRole('textbox', { name: '问题' })
    await user.type(textbox, '@查')

    expect(screen.getByRole('listbox', { name: '快捷任务' })).toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: /查资料/u }))

    expect(screen.getByText('本地原型')).toBeInTheDocument()
    expect(textbox).toHaveValue('请帮我找一份产品说明、宣传手册和解决方案。')
  })

  it('keeps direct Q&A in the same dialog and auto-selects a skill from natural language', async () => {
    const user = userEvent.setup()
    render(<PrototypePage />)

    expect(document.querySelectorAll('.prototype-task-card')).toHaveLength(0)
    const textbox = screen.getByRole('textbox', { name: '问题' })
    const send = screen.getByRole('button', { name: '发送问题' })

    await user.type(textbox, '产品标准部署需要哪些前置条件？')
    await user.click(send)
    expect(screen.getByText('直接问答')).toBeInTheDocument()

    await user.type(textbox, '找一份产品说明和宣传手册')
    await user.click(send)
    expect(screen.getByText('自动调用 · 查资料')).toBeInTheDocument()
    expect(screen.getByText('找到 3 份可用资料')).toBeInTheDocument()
  })

  it('keeps archived conversations in the chat workspace and restores them in place', async () => {
    const user = userEvent.setup()
    render(<PrototypePage />)

    const archiveFilter = screen.getByRole('button', { name: /已归档/u })
    expect(archiveFilter).toHaveTextContent('1')
    await user.click(archiveFilter)
    await user.click(screen.getByRole('button', { name: /零售客户方案讨论/u }))

    expect(screen.getAllByText('已归档').length).toBeGreaterThan(0)
    expect(screen.getByText('方案草稿已生成')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '恢复当前会话' }))

    expect(screen.getByText('方案草稿已生成')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '恢复当前会话' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '归档当前对话' })).toBeInTheDocument()
  })
})
