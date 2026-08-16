/// <reference types="node" />

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProductCitation, ProductConversation, ProductMessage } from '../../shared/api/product.js'
import { ChatPage } from './ChatPage'

const logout = vi.fn(async () => undefined)

vi.mock('../session/SessionProvider', () => ({
  useSession: () => ({
    user: { id: 'USR-1', name: '陈晨', avatarUrl: null },
    status: 'authenticated',
    logout,
    reload: vi.fn(),
  }),
}))

const conversationA: ProductConversation = {
  id: 'CVS-A',
  title: '项目 A',
  status: 'ACTIVE',
  messageCount: 1,
  createdAt: '2026-08-12T00:00:00.000Z',
  updatedAt: '2026-08-12T01:00:00.000Z',
}

const conversationB: ProductConversation = {
  ...conversationA,
  id: 'CVS-B',
  title: '项目 B',
  updatedAt: '2026-08-12T00:30:00.000Z',
}

const priorMessage: ProductMessage = {
  id: 'MSG-PRIOR',
  role: 'ASSISTANT',
  content: '原有回答',
  answerStatus: 'SUPPORTED',
  citations: [],
  createdAt: '2026-08-12T00:05:00.000Z',
}

const citation: ProductCitation = {
  id: 'CIT-1',
  kind: 'ENTERPRISE_EVIDENCE',
  title: '列表中的来源',
  path: null,
  locator: '第 1 页',
  excerpt: '列表摘要',
  versionAt: null,
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function detail(conversation: ProductConversation, messages: ProductMessage[] = [priorMessage]) {
  return { conversation, messages }
}

function mockFetch(handler: (path: string, init?: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => handler(String(input), init))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function emptyWorkspaceFetch() {
  return mockFetch((path) => {
    if (path === '/api/chat/conversations') return jsonResponse({ conversations: [] })
    throw new Error(`Unexpected request: ${path}`)
  })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  logout.mockClear()
})

describe('ChatPage product workspace', () => {
  it('shows an empty workspace without technical controls', async () => {
    emptyWorkspaceFetch()

    render(<ChatPage />)

    expect(await screen.findByRole('heading', { level: 1, name: '企业知识助手' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '问题' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新对话' })).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent(/上传资料|回答范围|Factory|Knowledge Factory|Yuxi|模型|Agent|智能体|Skill|知识库|@/iu)
  })

  it('blocks mutations during initial loading and ignores the response after starting a new conversation', async () => {
    const user = userEvent.setup()
    let resolveWorkspace!: (response: Response) => void
    const pendingWorkspace = new Promise<Response>((resolve) => { resolveWorkspace = resolve })
    const fetchMock = mockFetch((path) => {
      if (path === '/api/chat/conversations') return pendingWorkspace
      if (path === '/api/chat/conversations/CVS-A') return jsonResponse(detail(conversationA))
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)

    expect(screen.getByRole('textbox', { name: '问题' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '发送问题' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '新对话' }))
    expect(screen.getByRole('textbox', { name: '问题' })).toBeEnabled()

    await act(async () => {
      resolveWorkspace(jsonResponse({ conversations: [conversationA] }))
      await pendingWorkspace
    })

    expect(screen.getByText('开始一段新对话')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalledWith('/api/chat/conversations/CVS-A', expect.anything())
  })

  it('starts a new conversation by clearing the selected thread', async () => {
    const user = userEvent.setup()
    mockFetch((path) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA] })
      if (path === '/api/chat/conversations/CVS-A') return jsonResponse(detail(conversationA))
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)
    expect(await screen.findByText('原有回答')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '新对话' }))

    expect(screen.queryByText('原有回答')).not.toBeInTheDocument()
    expect(screen.getByText('开始一段新对话')).toBeInTheDocument()
  })

  it('manages focus and keyboard dismissal for the conversation drawer', async () => {
    const user = userEvent.setup()
    emptyWorkspaceFetch()
    render(<ChatPage />)
    await screen.findByText('开始一段新对话')
    const trigger = screen.getByRole('button', { name: '打开对话列表' })

    expect(trigger).toHaveAttribute('aria-controls', 'conversation-sidebar')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await user.click(trigger)

    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const close = within(screen.getByLabelText('对话列表')).getByRole('button', { name: '关闭对话列表' })
    await waitFor(() => expect(close).toHaveFocus())
    await user.tab({ shift: true })
    expect(screen.getByRole('button', { name: '新对话' })).toHaveFocus()
    await user.tab()
    expect(close).toHaveFocus()
    await user.keyboard('{Escape}')

    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveFocus()
  })

  it('creates the first conversation with an empty body, sends content, and clears the successful draft', async () => {
    const user = userEvent.setup()
    const createdConversation = { ...conversationA, messageCount: 0 }
    const userMessage: ProductMessage = { ...priorMessage, id: 'MSG-U', role: 'USER', content: '上线条件是什么？', answerStatus: null }
    const assistantMessage: ProductMessage = { ...priorMessage, id: 'MSG-A', content: '需要完成审批。' }
    const fetchMock = mockFetch((path, init) => {
      if (path === '/api/chat/conversations' && !init?.method) return jsonResponse({ conversations: [] })
      if (path === '/api/chat/conversations' && init?.method === 'POST') return jsonResponse({ conversation: createdConversation })
      if (path === '/api/chat/conversations/CVS-A/messages' && init?.method === 'POST') {
        return jsonResponse({ conversation: { ...conversationA, messageCount: 2 }, userMessage, assistantMessage })
      }
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)
    const textbox = await screen.findByRole('textbox', { name: '问题' })

    await user.type(textbox, '上线条件是什么？')
    await user.click(screen.getByRole('button', { name: '发送问题' }))

    expect(await screen.findByText('需要完成审批。')).toBeInTheDocument()
    expect(textbox).toHaveValue('')
    expect(screen.getAllByText(/上线条件是什么？|需要完成审批。/).map((node) => node.textContent)).toEqual([
      '上线条件是什么？',
      '需要完成审批。',
    ])
    expect(fetchMock).toHaveBeenCalledWith('/api/chat/conversations', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({}),
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/chat/conversations/CVS-A/messages', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ content: '上线条件是什么？' }),
    }))
  })

  it('preserves the draft and prior messages after a send failure and offers retry', async () => {
    const user = userEvent.setup()
    let messageAttempts = 0
    const recoveredUser: ProductMessage = { ...priorMessage, id: 'MSG-U', role: 'USER', content: '再查一次', answerStatus: null }
    const recoveredAssistant: ProductMessage = { ...priorMessage, id: 'MSG-A', content: '重试成功' }
    mockFetch((path, init) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA] })
      if (path === '/api/chat/conversations/CVS-A' && !init?.method) return jsonResponse(detail(conversationA))
      if (path === '/api/chat/conversations/CVS-A/messages') {
        messageAttempts += 1
        return messageAttempts === 1
          ? jsonResponse({ error: { code: 'SEND_FAILED', message: 'internal detail' } }, 500)
          : jsonResponse({ conversation: conversationA, userMessage: recoveredUser, assistantMessage: recoveredAssistant })
      }
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)
    expect(await screen.findByText('原有回答')).toBeInTheDocument()
    const textbox = screen.getByRole('textbox', { name: '问题' })

    await user.type(textbox, '再查一次')
    await user.click(screen.getByRole('button', { name: '发送问题' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('发送失败，请重试')
    expect(screen.getByText('原有回答')).toBeInTheDocument()
    expect(textbox).toHaveValue('再查一次')
    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('重试成功')).toBeInTheDocument()
  })

  it('locks conversation actions during send without clearing the draft', async () => {
    const user = userEvent.setup()
    let resolveSend!: (response: Response) => void
    const pendingSend = new Promise<Response>((resolve) => { resolveSend = resolve })
    mockFetch((path, init) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA, conversationB] })
      if (path === '/api/chat/conversations/CVS-A' && !init?.method) return jsonResponse(detail(conversationA))
      if (path === '/api/chat/conversations/CVS-A/messages') return pendingSend
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)
    expect(await screen.findByText('原有回答')).toBeInTheDocument()
    const textbox = screen.getByRole('textbox', { name: '问题' })

    await user.type(textbox, '发送期间保留')
    await user.click(screen.getByRole('button', { name: '发送问题' }))

    await waitFor(() => expect(screen.getByRole('button', { name: '新对话' })).toBeDisabled())
    expect(screen.getByRole('button', { name: '项目 B' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '归档当前对话' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '发送问题' })).toBeDisabled()
    expect(textbox).toHaveValue('发送期间保留')

    await act(async () => {
      resolveSend(jsonResponse({
        conversation: conversationA,
        userMessage: { ...priorMessage, id: 'MSG-U', role: 'USER', content: '发送期间保留', answerStatus: null },
        assistantMessage: { ...priorMessage, id: 'MSG-A', content: '已回答' },
      }))
      await pendingSend
    })
  })

  it('finishes initial loading when switching away from a pending first detail', async () => {
    const user = userEvent.setup()
    let resolveA!: (response: Response) => void
    const pendingA = new Promise<Response>((resolve) => { resolveA = resolve })
    mockFetch((path) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA, conversationB] })
      if (path === '/api/chat/conversations/CVS-A') return pendingA
      if (path === '/api/chat/conversations/CVS-B') {
        return jsonResponse(detail(conversationB, [{ ...priorMessage, id: 'MSG-B', content: 'B 当前回答' }]))
      }
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)

    await user.click(await screen.findByRole('button', { name: '项目 B' }))

    expect(await screen.findByText('B 当前回答')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '问题' })).toBeEnabled()
    await act(async () => {
      resolveA(jsonResponse(detail(conversationA, [{ ...priorMessage, content: 'A 迟到回答' }])))
      await pendingA
    })
    expect(screen.queryByText('A 迟到回答')).not.toBeInTheDocument()
  })

  it('ignores a late conversation response after switching back', async () => {
    const user = userEvent.setup()
    let resolveB!: (response: Response) => void
    const pendingB = new Promise<Response>((resolve) => { resolveB = resolve })
    let aLoads = 0
    mockFetch((path) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA, conversationB] })
      if (path === '/api/chat/conversations/CVS-A') {
        aLoads += 1
        return jsonResponse(detail(conversationA, [{ ...priorMessage, content: aLoads === 1 ? 'A 初始回答' : 'A 最新回答' }]))
      }
      if (path === '/api/chat/conversations/CVS-B') return pendingB
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)
    expect(await screen.findByText('A 初始回答')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '项目 B' }))
    const switchBack = screen.getByRole('button', { name: '项目 A' })
    expect(switchBack).toBeEnabled()
    expect(screen.getByRole('button', { name: '归档当前对话' })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: '问题' })).toBeDisabled()

    await user.click(switchBack)
    expect(await screen.findByText('A 最新回答')).toBeInTheDocument()
    await act(async () => {
      resolveB(jsonResponse(detail(conversationB, [{ ...priorMessage, id: 'MSG-B', content: 'B 迟到回答' }])))
      await pendingB
    })

    expect(screen.getByText('A 最新回答')).toBeInTheDocument()
    expect(screen.queryByText('B 迟到回答')).not.toBeInTheDocument()
  })

  it('archives through the product endpoint and handles an empty 204 response', async () => {
    const user = userEvent.setup()
    const fetchMock = mockFetch((path, init) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA] })
      if (path === '/api/chat/conversations/CVS-A' && !init?.method) return jsonResponse(detail(conversationA))
      if (path === '/api/chat/conversations/CVS-A/archive' && init?.method === 'POST') return new Response(null, { status: 204 })
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)
    expect(await screen.findByText('原有回答')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '归档当前对话' }))

    await waitFor(() => expect(screen.getByRole('textbox', { name: '问题' })).toBeDisabled())
    expect(screen.getByText('已归档')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/chat/conversations/CVS-A/archive', expect.objectContaining({ method: 'POST' }))
  })

  it('fetches citation detail before opening the drawer and restores trigger focus on close', async () => {
    const user = userEvent.setup()
    const detailedCitation: ProductCitation = {
      ...citation,
      title: '飞书中的完整来源',
      path: '产品中心 / 项目规范',
      excerpt: '完整来源内容',
    }
    const fetchMock = mockFetch((path) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA] })
      if (path === '/api/chat/conversations/CVS-A') {
        return jsonResponse(detail(conversationA, [{ ...priorMessage, citations: [citation] }]))
      }
      if (path === '/api/citations/CIT-1') return jsonResponse(detailedCitation)
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)
    const trigger = await screen.findByRole('button', { name: '[1]' })
    expect(trigger).toHaveAttribute('aria-controls', 'source-drawer')
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    await user.click(trigger)

    const drawer = await screen.findByRole('dialog', { name: '来源详情' })
    expect(drawer).toHaveAttribute('id', 'source-drawer')
    expect(drawer).toHaveTextContent('飞书中的完整来源')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(fetchMock).toHaveBeenCalledWith('/api/citations/CIT-1', expect.any(Object))
    await user.click(screen.getByRole('button', { name: '关闭来源' }))
    expect(trigger).toHaveFocus()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('keeps the fixed three-column chat layout and static composer dock', () => {
    const appCss = readFileSync('src/styles/app.css', 'utf8')

    expect(appCss).toMatch(/\.chat-layout\s*\{[^}]*grid-template-columns:\s*220px minmax\(0, 1fr\)/s)
    expect(appCss).toMatch(/\.chat-layout\.source-open\s*\{[^}]*grid-template-columns:\s*220px minmax\(0, 1fr\) 320px/s)
    expect(appCss).toMatch(/\.chat-main\s*\{[^}]*grid-template-rows:\s*56px minmax\(0, 1fr\) auto/s)
    expect(appCss).toMatch(/\.chat-message-scroll\s*\{[^}]*overflow-y:\s*auto;[^}]*overflow-x:\s*hidden/s)
    expect(appCss).toMatch(/\.chat-composer-dock\s*\{[^}]*position:\s*static;[^}]*padding:\s*12px 24px 18px/s)
    expect(appCss).toMatch(/\.conversation-sidebar,[^}]*\.source-drawer\s*\{[^}]*border-color:\s*transparent;[^}]*background:\s*#f4f8fd/s)
  })
})
