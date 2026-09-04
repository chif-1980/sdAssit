/// <reference types="node" />

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProductCitation, ProductConversation, ProductMaterial, ProductMessage } from '../../shared/api/product.js'
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

const material: ProductMaterial = {
  id: 'AST-MATERIAL',
  title: '产品说明 v3.2.pdf',
  type: '产品说明',
  fileName: '产品说明 v3.2.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 2400,
  updatedAt: '2026-08-28T12:00:00.000Z',
  summary: '覆盖产品定位和部署要求。',
  status: 'PUBLISHED',
  approvalStatus: 'APPROVED',
  publicationStatus: 'PUBLISHED',
  citation,
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function sseResponse(body: unknown) {
  return new Response([
    'event: progress\ndata: {"stage":"UNDERSTANDING","message":"正在结合当前对话理解问题"}\n\n',
    'event: progress\ndata: {"stage":"COMPOSING","message":"正在整理结论和可核验来源"}\n\n',
    `event: complete\ndata: ${JSON.stringify(body)}\n\n`,
  ].join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

function completeProgressSseResponse(body: unknown) {
  return new Response([
    'event: progress\ndata: {"stage":"UNDERSTANDING","message":"正在结合当前对话理解问题"}\n\n',
    'event: progress\ndata: {"stage":"RETRIEVING","message":"正在检索已审核发布的资料"}\n\n',
    'event: progress\ndata: {"stage":"VERIFYING","message":"正在核对原文与适用条件"}\n\n',
    'event: progress\ndata: {"stage":"COMPOSING","message":"正在整理结论和可核验来源"}\n\n',
    `event: complete\ndata: ${JSON.stringify(body)}\n\n`,
  ].join(''), {
    headers: { 'content-type': 'text/event-stream' },
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

function stubMatchMedia(matches: boolean) {
  let currentMatches = matches
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const mediaQuery = {
    get matches() { return currentMatches },
    media: '(max-width: 1024px)',
    onchange: null,
    addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener)),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    setMatches(nextMatches: boolean) {
      currentMatches = nextMatches
      listeners.forEach((listener) => listener({ matches: nextMatches, media: mediaQuery.media } as MediaQueryListEvent))
    },
  }
  vi.stubGlobal('matchMedia', vi.fn(() => mediaQuery))
  return mediaQuery
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  const browserNavigator = navigator as unknown as { share?: unknown; canShare?: unknown }
  delete browserNavigator.share
  delete browserNavigator.canShare
  logout.mockClear()
})

describe('ChatPage product workspace', () => {
  it('shows an empty workspace without technical controls', async () => {
    emptyWorkspaceFetch()

    render(<ChatPage />)

    const productHeading = await screen.findByRole('heading', { level: 1, name: '企业知识助手' })
    expect(productHeading).toBeInTheDocument()
    expect(productHeading.closest('.assistant-brand')?.querySelector('img')).toHaveAttribute('src', '/quickdone-mark.webp')
    expect(screen.getByRole('heading', { level: 2, name: '开始一段新对话' })).toBeInTheDocument()
    expect(screen.getByText('示例问题')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /产品标准部署|部署模式|实施方案/u })).toHaveLength(3)
    expect(screen.getByRole('textbox', { name: '问题' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新对话' })).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent(/上传资料|回答范围|Factory|Knowledge Factory|Yuxi|模型|Agent|智能体|Skill|知识库|@/iu)
  })

  it('fills the composer with an example question and returns to concise mode', async () => {
    const user = userEvent.setup()
    emptyWorkspaceFetch()
    render(<ChatPage />)

    await screen.findByRole('heading', { level: 2, name: '开始一段新对话' })
    await user.click(screen.getByRole('button', { name: '详细模式' }))
    await user.click(screen.getByRole('button', { name: '产品标准部署需要哪些前置条件？' }))

    expect(screen.getByRole('textbox', { name: '问题' })).toHaveValue('产品标准部署需要哪些前置条件？')
    expect(screen.getByRole('button', { name: '简洁模式' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '详细模式' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('keeps the selected skill marker so the user can type the requirement after it', async () => {
    const user = userEvent.setup()
    emptyWorkspaceFetch()
    render(<ChatPage />)

    await screen.findByRole('heading', { level: 2, name: '开始一段新对话' })
    const textbox = screen.getByRole('textbox', { name: '问题' })
    await user.type(textbox, '@查')
    await user.click(screen.getByRole('option', { name: /@查资料/u }))

    expect(textbox).toHaveValue('@查资料 ')
    expect(textbox).not.toHaveValue('请帮我找一份产品说明、宣传手册和解决方案。')

    await user.type(textbox, '找产品说明')
    expect(textbox).toHaveValue('@查资料 找产品说明')
  })

  it('replaces only the trailing mention and preserves text before it', async () => {
    const user = userEvent.setup()
    emptyWorkspaceFetch()
    render(<ChatPage />)

    await screen.findByRole('heading', { level: 2, name: '开始一段新对话' })
    const textbox = screen.getByRole('textbox', { name: '问题' })
    await user.type(textbox, '请帮我 @查')
    await user.click(screen.getByRole('option', { name: /@查资料/u }))

    expect(textbox).toHaveValue('请帮我 @查资料 ')
  })

  it('removes a selected skill atomically and clears its active state', async () => {
    const user = userEvent.setup()
    emptyWorkspaceFetch()
    render(<ChatPage />)

    await screen.findByRole('heading', { level: 2, name: '开始一段新对话' })
    const textbox = screen.getByRole('textbox', { name: '问题' }) as HTMLTextAreaElement
    await user.type(textbox, '@查')
    await user.click(screen.getByRole('option', { name: /@查资料/u }))
    expect(screen.getByText('查资料')).toBeInTheDocument()

    textbox.setSelectionRange('@查资料 '.length, '@查资料 '.length)
    fireEvent.keyDown(textbox, { key: 'Backspace' })

    expect(textbox).toHaveValue('')
    expect(screen.queryByText('查资料')).not.toBeInTheDocument()
  })

  it('sends the selected skill id together with the user-entered requirement', async () => {
    const user = userEvent.setup()
    const createdConversation = { ...conversationA, messageCount: 0 }
    const userMessage: ProductMessage = {
      ...priorMessage,
      id: 'MSG-SKILL-U',
      role: 'USER',
      content: '@查资料 找产品说明',
      answerStatus: null,
    }
    const assistantMessage: ProductMessage = {
      ...priorMessage,
      id: 'MSG-SKILL-A',
      content: '已找到相关资料。',
    }
    const fetchMock = mockFetch((path, init) => {
      if (path === '/api/chat/conversations' && !init?.method) return jsonResponse({ conversations: [] })
      if (path === '/api/chat/conversations' && init?.method === 'POST') return jsonResponse({ conversation: createdConversation })
      if (path === `/api/chat/conversations/${createdConversation.id}/messages/stream` && init?.method === 'POST') {
        return sseResponse({
          conversation: { ...createdConversation, messageCount: 2 },
          userMessage,
          assistantMessage,
        })
      }
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)

    const textbox = await screen.findByRole('textbox', { name: '问题' })
    await user.type(textbox, '@查')
    await user.click(screen.getByRole('option', { name: /@查资料/u }))
    await user.type(textbox, '找产品说明')
    await user.click(screen.getByRole('button', { name: '发送问题' }))

    expect(await screen.findByText('已找到相关资料。')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/chat/conversations/${createdConversation.id}/messages/stream`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          content: '@查资料 找产品说明',
          mode: 'CONCISE',
          skillId: 'MATERIAL_SEARCH',
        }),
      }),
    )
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

  it('restores material cards in an existing chat without changing the ordinary conversation flow', async () => {
    mockFetch((path) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA] })
      if (path === '/api/chat/conversations/CVS-A') {
        return jsonResponse(detail(conversationA, [{ ...priorMessage, materials: [material] }]))
      }
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)

    expect(await screen.findByRole('region', { name: '资料检索结果' })).toBeInTheDocument()
    expect(screen.getByText('产品说明 v3.2.pdf')).toBeInTheDocument()
    expect(screen.getByText('已审核 · 已发布')).toBeInTheDocument()
    expect(screen.getByText('查资料')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '问题' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '新对话' })).toBeInTheDocument()
  })

  it('downloads a material from the chat card and shows a success message', async () => {
    const user = userEvent.setup()
    const createObjectURL = vi.fn(() => 'blob:material')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    const fetchMock = mockFetch((path) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA] })
      if (path === '/api/chat/conversations/CVS-A') return jsonResponse(detail(conversationA, [{ ...priorMessage, materials: [material] }]))
      if (path === '/api/chat/materials/AST-MATERIAL/download') return new Response(new Blob(['资料正文'], { type: 'application/pdf' }))
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)

    await user.click(await screen.findByRole('button', { name: '下载' }))

    expect(await screen.findByRole('status')).toHaveTextContent('已下载「产品说明 v3.2.pdf」')
    expect(fetchMock).toHaveBeenCalledWith('/api/chat/materials/AST-MATERIAL/download', expect.objectContaining({ credentials: 'include' }))
    expect(createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('prepares a Feishu distribution and uses the mobile share sheet when available', async () => {
    const user = userEvent.setup()
    const share = vi.fn<(data: ShareData) => Promise<void>>(async () => undefined)
    Object.defineProperty(navigator, 'share', { configurable: true, value: share })
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true })
    const fetchMock = mockFetch((path, init) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA] })
      if (path === '/api/chat/conversations/CVS-A') return jsonResponse(detail(conversationA, [{ ...priorMessage, materials: [material] }]))
      if (path === '/api/chat/materials/AST-MATERIAL/distributions' && init?.method === 'POST') {
        return jsonResponse({
          distribution: { id: 'DST-1', materialId: 'AST-MATERIAL', requesterId: 'USR-1', channel: 'FEISHU', mode: 'DEVICE_SHARE', status: 'READY', createdAt: '2026-08-28T12:00:00.000Z' },
          title: material.title,
          text: '产品说明 v3.2.pdf\n来源：飞书知识库',
          downloadUrl: '/api/chat/materials/AST-MATERIAL/download',
          requiresUserConfirmation: true,
        })
      }
      if (path === '/api/chat/materials/AST-MATERIAL/download') return new Response(new Blob(['资料正文'], { type: 'application/pdf' }))
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)

    await user.click(await screen.findByRole('button', { name: '分发' }))
    expect(screen.getByRole('dialog', { name: '选择发送到的应用' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /飞书/u }))

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledWith('/api/chat/materials/AST-MATERIAL/distributions', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ channel: 'FEISHU' }),
    }))
    expect(share.mock.calls[0]?.[0]).toMatchObject({
      text: '产品说明 v3.2.pdf\n来源：飞书知识库',
      files: [expect.any(File)],
    })
    expect(screen.getByRole('dialog', { name: '选择发送到的应用' })).toHaveTextContent('已打开飞书系统分享面板')
  })

  it('downloads the material and attempts to open WeChat when the device share sheet is unavailable', async () => {
    const user = userEvent.setup()
    const createObjectURL = vi.fn(() => 'blob:material')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    const open = vi.fn(() => ({ closed: false }) as unknown as Window)
    Object.defineProperty(window, 'open', { configurable: true, value: open })
    const fetchMock = mockFetch((path, init) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA] })
      if (path === '/api/chat/conversations/CVS-A') return jsonResponse(detail(conversationA, [{ ...priorMessage, materials: [material] }]))
      if (path === '/api/chat/materials/AST-MATERIAL/distributions' && init?.method === 'POST') {
        return jsonResponse({
          distribution: { id: 'DST-2', materialId: 'AST-MATERIAL', requesterId: 'USR-1', channel: 'WECHAT', mode: 'DEVICE_SHARE', status: 'READY', createdAt: '2026-08-28T12:00:00.000Z' },
          title: material.title,
          text: '产品说明 v3.2.pdf\n来源：飞书知识库',
          downloadUrl: '/api/chat/materials/AST-MATERIAL/download',
          requiresUserConfirmation: true,
        })
      }
      if (path === '/api/chat/materials/AST-MATERIAL/download') return new Response(new Blob(['资料正文'], { type: 'application/pdf' }))
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)

    await user.click(await screen.findByRole('button', { name: '分发' }))
    await user.click(screen.getByRole('button', { name: /微信/u }))

    await waitFor(() => expect(open).toHaveBeenCalledWith('weixin://', '_self'))
    expect(fetchMock).toHaveBeenCalledWith('/api/chat/materials/AST-MATERIAL/download', expect.objectContaining({ credentials: 'include' }))
    expect(screen.getByRole('dialog', { name: '选择发送到的应用' })).toHaveTextContent('资料已下载，并已尝试打开微信')
  })

  it('resets the answer mode when starting a new conversation', async () => {
    const user = userEvent.setup()
    mockFetch((path) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA] })
      if (path === '/api/chat/conversations/CVS-A') return jsonResponse(detail(conversationA))
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)
    expect(await screen.findByText('原有回答')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '详细模式' }))
    await user.click(screen.getByRole('button', { name: '新对话' }))

    expect(screen.getByRole('button', { name: '简洁模式' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '详细模式' })).toHaveAttribute('aria-pressed', 'false')
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
    expect(screen.getByRole('button', { name: /已归档/ })).toHaveFocus()
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
      if (path === '/api/chat/conversations/CVS-A/messages/stream' && init?.method === 'POST') {
        return sseResponse({ conversation: { ...conversationA, messageCount: 2 }, userMessage, assistantMessage })
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
    expect(fetchMock).toHaveBeenCalledWith('/api/chat/conversations/CVS-A/messages/stream', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ content: '上线条件是什么？', mode: 'CONCISE' }),
    }))
  })

  it('sends the selected detailed answer mode', async () => {
    const user = userEvent.setup()
    const fetchMock = mockFetch((path, init) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA] })
      if (path === '/api/chat/conversations/CVS-A' && !init?.method) return jsonResponse(detail(conversationA))
      if (path === '/api/chat/conversations/CVS-A/messages/stream' && init?.method === 'POST') {
        return sseResponse({
          conversation: conversationA,
          userMessage: { ...priorMessage, id: 'MSG-U', role: 'USER', answerStatus: null },
          assistantMessage: { ...priorMessage, id: 'MSG-A' },
        })
      }
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)
    expect(await screen.findByText('原有回答')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '详细模式' }))
    await user.type(screen.getByRole('textbox', { name: '问题' }), '给出完整实施说明')
    await user.click(screen.getByRole('button', { name: '发送问题' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat/conversations/CVS-A/messages/stream',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ content: '给出完整实施说明', mode: 'DETAILED' }),
      }),
    ))
  })

  it('uploads selected files before sending the question and includes their ids', async () => {
    const user = userEvent.setup()
    const uploadedAttachment = {
      id: 'ATT-1',
      name: '方案.pdf',
      mimeType: 'application/pdf',
      size: 7,
      status: 'READY',
    }
    const userMessage: ProductMessage = { ...priorMessage, id: 'MSG-U', role: 'USER', content: '请结合方案回答', answerStatus: null }
    const assistantMessage: ProductMessage = { ...priorMessage, id: 'MSG-A', content: '已结合方案。' }
    const fetchMock = mockFetch((path, init) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA] })
      if (path === '/api/chat/conversations/CVS-A' && !init?.method) return jsonResponse(detail(conversationA))
      if (path === '/api/chat/conversations/CVS-A/attachments' && init?.method === 'POST') {
        return jsonResponse({ attachment: uploadedAttachment }, 202)
      }
      if (path === '/api/chat/conversations/CVS-A/messages/stream' && init?.method === 'POST') {
        return sseResponse({ conversation: { ...conversationA, messageCount: 3 }, userMessage, assistantMessage })
      }
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)
    expect(await screen.findByText('原有回答')).toBeInTheDocument()

    const file = new File(['方案内容'], '方案.pdf', { type: 'application/pdf' })
    await user.upload(screen.getByLabelText('选择附件'), file)
    await user.type(screen.getByRole('textbox', { name: '问题' }), '请结合方案回答')
    await user.click(screen.getByRole('button', { name: '发送问题' }))

    expect(await screen.findByText('已结合方案。')).toBeInTheDocument()
    const uploadCall = fetchMock.mock.calls.find(([path]) => path === '/api/chat/conversations/CVS-A/attachments')
    expect(uploadCall).toBeDefined()
    expect(uploadCall?.[1]?.body).toBeInstanceOf(FormData)
    expect((uploadCall?.[1]?.body as FormData).get('file')).toBeInstanceOf(File)
    expect(fetchMock).toHaveBeenCalledWith('/api/chat/conversations/CVS-A/messages/stream', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        content: '请结合方案回答',
        mode: 'CONCISE',
        attachmentIds: ['ATT-1'],
      }),
    }))
  })

  it('keeps an attachment and explains the failure when upload is rejected', async () => {
    const user = userEvent.setup()
    mockFetch((path, init) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA] })
      if (path === '/api/chat/conversations/CVS-A' && !init?.method) return jsonResponse(detail(conversationA))
      if (path === '/api/chat/conversations/CVS-A/attachments' && init?.method === 'POST') {
        return jsonResponse({ error: { code: 'UNSUPPORTED_FORMAT', message: '暂不支持此文件格式' } }, 400)
      }
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)
    expect(await screen.findByText('原有回答')).toBeInTheDocument()

    const file = new File(['binary'], '资料.pdf', { type: 'application/pdf' })
    await user.upload(screen.getByLabelText('选择附件'), file)
    await user.type(screen.getByRole('textbox', { name: '问题' }), '请分析资料')
    await user.click(screen.getByRole('button', { name: '发送问题' }))

    expect(await screen.findByText('暂不支持此文件格式')).toBeInTheDocument()
    expect(screen.getByText('资料.pdf')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '移除附件 资料.pdf' })).toBeInTheDocument()
    expect(screen.queryByText('原有回答')).toBeInTheDocument()
  })

  it('shows streamed answer text before the complete event arrives', async () => {
    const user = userEvent.setup()
    const encoder = new TextEncoder()
    let streamController!: ReadableStreamDefaultController<Uint8Array>
    const userMessage: ProductMessage = {
      ...priorMessage,
      id: 'MSG-STREAM-U',
      role: 'USER',
      content: '是否支持私有部署？',
      answerStatus: null,
    }
    const assistantMessage: ProductMessage = {
      ...priorMessage,
      id: 'MSG-STREAM-A',
      content: '## 结论\n\n支持私有部署。',
    }
    mockFetch((path, init) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA] })
      if (path === '/api/chat/conversations/CVS-A' && !init?.method) return jsonResponse(detail(conversationA))
      if (path === '/api/chat/conversations/CVS-A/messages/stream' && init?.method === 'POST') {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { streamController = controller },
        }), { headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)
    expect(await screen.findByText('原有回答')).toBeInTheDocument()

    await user.type(screen.getByRole('textbox', { name: '问题' }), '是否支持私有部署？')
    await user.click(screen.getByRole('button', { name: '发送问题' }))
    await act(async () => {
      streamController.enqueue(encoder.encode(
        'event: progress\ndata: {"stage":"UNDERSTANDING","message":"正在结合当前对话理解问题"}\n\n'
        + 'event: progress\ndata: {"stage":"RETRIEVING","message":"正在检索已审核发布的资料"}\n\n'
        + 'event: progress\ndata: {"stage":"VERIFYING","message":"正在核对原文与适用条件"}\n\n'
        + 'event: progress\ndata: {"stage":"COMPOSING","message":"正在整理结论和可核验来源"}\n\n'
        + 'event: delta\ndata: {"content":"## 结论\\n\\n支持"}\n\n',
      ))
    })

    expect(await screen.findByRole('heading', { level: 2, name: '结论' })).toBeInTheDocument()
    expect(screen.getByText('支持')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('正在生成')
    expect(within(document.querySelector('.message-streaming') as HTMLElement)
      .queryByRole('button', { name: '点赞这条回答' })).not.toBeInTheDocument()

    await act(async () => {
      streamController.enqueue(encoder.encode('event: delta\ndata: {"content":"私有部署。"}\n\n'))
    })
    expect(await screen.findByText('支持私有部署。')).toBeInTheDocument()

    await act(async () => {
      streamController.enqueue(encoder.encode(
        `event: complete\ndata: ${JSON.stringify({
          conversation: { ...conversationA, messageCount: 3 },
          userMessage,
          assistantMessage,
        })}\n\n`,
      ))
      streamController.close()
    })

    await waitFor(() => expect(screen.queryByText('正在生成')).not.toBeInTheDocument())
    expect(screen.getAllByRole('button', { name: '点赞这条回答' })).toHaveLength(2)
    expect(screen.getAllByText('是否支持私有部署？')).toHaveLength(1)
  })

  it('plays all production progress events before replacing them with the final answer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const userMessage: ProductMessage = {
      ...priorMessage,
      id: 'MSG-PROGRESS-U',
      role: 'USER',
      content: '什么是智能客服？',
      answerStatus: null,
    }
    const assistantMessage: ProductMessage = {
      ...priorMessage,
      id: 'MSG-PROGRESS-A',
      content: '智能客服是企业服务方案。',
    }
    mockFetch((path, init) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA] })
      if (path === '/api/chat/conversations/CVS-A' && !init?.method) return jsonResponse(detail(conversationA))
      if (path === '/api/chat/conversations/CVS-A/messages/stream' && init?.method === 'POST') {
        return completeProgressSseResponse({
          conversation: { ...conversationA, messageCount: 3 },
          userMessage,
          assistantMessage,
        })
      }
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)
    expect(await screen.findByText('原有回答')).toBeInTheDocument()

    await user.type(screen.getByRole('textbox', { name: '问题' }), '什么是智能客服？')
    await user.click(screen.getByRole('button', { name: '发送问题' }))

    expect(screen.getByText('理解问题').closest('li')).toHaveClass('is-current')
    expect(screen.queryByText('智能客服是企业服务方案。')).not.toBeInTheDocument()
    act(() => vi.advanceTimersByTime(600))
    expect(screen.getByText('检索资料').closest('li')).toHaveClass('is-current')
    act(() => vi.advanceTimersByTime(600))
    expect(screen.getByText('核对依据').closest('li')).toHaveClass('is-current')
    act(() => vi.advanceTimersByTime(600))
    expect(screen.getByText('组织答案').closest('li')).toHaveClass('is-current')
    act(() => vi.advanceTimersByTime(600))
    expect(await screen.findByText('智能客服是企业服务方案。')).toBeInTheDocument()
  })

  it('submits, switches, and persists feedback through the product feedback endpoint', async () => {
    const user = userEvent.setup()
    const fetchMock = mockFetch((path, init) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA] })
      if (path === '/api/chat/conversations/CVS-A') {
        return jsonResponse(detail(conversationA, [{ ...priorMessage, feedbackRating: null }]))
      }
      if (path === '/api/chat/messages/MSG-PRIOR/feedback' && init?.method === 'PUT') {
        const { rating } = JSON.parse(String(init.body)) as { rating: 'LIKE' | 'DISLIKE' | null }
        return jsonResponse({ messageId: 'MSG-PRIOR', feedbackRating: rating })
      }
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)
    const like = await screen.findByRole('button', { name: '点赞这条回答' })
    const dislike = screen.getByRole('button', { name: '点踩这条回答' })

    await user.click(like)
    await waitFor(() => expect(like).toHaveAttribute('aria-pressed', 'true'))
    await waitFor(() => expect(like).toBeEnabled())
    expect(dislike).toHaveAttribute('aria-pressed', 'false')
    expect(fetchMock).toHaveBeenCalledWith('/api/chat/messages/MSG-PRIOR/feedback', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ rating: 'LIKE' }),
    }))

    await user.click(dislike)
    await user.click(screen.getByRole('button', { name: '提交反馈' }))
    await waitFor(() => expect(dislike).toHaveAttribute('aria-pressed', 'true'))
    expect(like).toHaveAttribute('aria-pressed', 'false')
    expect(fetchMock).toHaveBeenLastCalledWith('/api/chat/messages/MSG-PRIOR/feedback', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ rating: 'DISLIKE', reasonType: 'CONTENT_ERROR', reasonText: undefined }),
    }))
  })

  it('rolls back optimistic feedback when submission fails', async () => {
    const user = userEvent.setup()
    mockFetch((path, init) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA] })
      if (path === '/api/chat/conversations/CVS-A') {
        return jsonResponse(detail(conversationA, [{ ...priorMessage, feedbackRating: 'LIKE' }]))
      }
      if (path === '/api/chat/messages/MSG-PRIOR/feedback' && init?.method === 'PUT') {
        return jsonResponse({ error: { code: 'FEEDBACK_FAILED', message: 'internal detail' } }, 500)
      }
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)
    const like = await screen.findByRole('button', { name: '点赞这条回答' })
    const dislike = screen.getByRole('button', { name: '点踩这条回答' })

    await user.click(dislike)
    await user.click(screen.getByRole('button', { name: '提交反馈' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('反馈提交失败，请重试')
    expect(like).toHaveAttribute('aria-pressed', 'true')
    expect(dislike).toHaveAttribute('aria-pressed', 'false')
  })

  it('preserves the draft and prior messages after a send failure and offers retry', async () => {
    const user = userEvent.setup()
    let messageAttempts = 0
    const recoveredUser: ProductMessage = { ...priorMessage, id: 'MSG-U', role: 'USER', content: '再查一次', answerStatus: null }
    const recoveredAssistant: ProductMessage = { ...priorMessage, id: 'MSG-A', content: '重试成功' }
    mockFetch((path, init) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA] })
      if (path === '/api/chat/conversations/CVS-A' && !init?.method) return jsonResponse(detail(conversationA))
      if (path === '/api/chat/conversations/CVS-A/messages/stream') {
        messageAttempts += 1
        return messageAttempts === 1
          ? jsonResponse({ error: { code: 'SEND_FAILED', message: 'internal detail' } }, 500)
          : sseResponse({ conversation: conversationA, userMessage: recoveredUser, assistantMessage: recoveredAssistant })
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

  it('locks conversation actions during send and clears the draft', async () => {
    const user = userEvent.setup()
    let resolveSend!: (response: Response) => void
    const pendingSend = new Promise<Response>((resolve) => { resolveSend = resolve })
    mockFetch((path, init) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA, conversationB] })
      if (path === '/api/chat/conversations/CVS-A' && !init?.method) return jsonResponse(detail(conversationA))
      if (path === '/api/chat/conversations/CVS-A/messages/stream') return pendingSend
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
    const stop = screen.getByRole('button', { name: '停止生成' })
    expect(stop).toBeEnabled()
    expect(screen.getByRole('button', { name: '简洁模式' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '详细模式' })).toBeDisabled()
    expect(textbox).toHaveValue('')
    expect(document.querySelector('.message-pending-question')).toHaveTextContent('发送期间保留')
    expect(screen.getByRole('status', { name: '正在整理答案' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '查看处理详情' })).toBeInTheDocument()

    await act(async () => {
      resolveSend(sseResponse({
        conversation: conversationA,
        userMessage: { ...priorMessage, id: 'MSG-U', role: 'USER', content: '发送期间保留', answerStatus: null },
        assistantMessage: { ...priorMessage, id: 'MSG-A', content: '已回答' },
      }))
      await pendingSend
    })
    expect(screen.queryByRole('status', { name: '正在整理答案' })).not.toBeInTheDocument()
    expect(document.querySelector('.message-user:not(.message-pending-question)')).toHaveTextContent('发送期间保留')
    expect(screen.getByText('已回答')).toBeInTheDocument()
  })

  it('stops an in-flight request without showing a send error', async () => {
    const user = userEvent.setup()
    let resolveSend!: (response: Response) => void
    let requestSignal!: AbortSignal
    const pendingSend = new Promise<Response>((resolve) => { resolveSend = resolve })
    mockFetch((path, init) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA] })
      if (path === '/api/chat/conversations/CVS-A' && !init?.method) return jsonResponse(detail(conversationA))
      if (path === '/api/chat/conversations/CVS-A/messages/stream') {
        requestSignal = init?.signal as AbortSignal
        return pendingSend
      }
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)
    expect(await screen.findByText('原有回答')).toBeInTheDocument()
    const textbox = screen.getByRole('textbox', { name: '问题' })

    await user.type(textbox, '需要中止的问题')
    await user.click(screen.getByRole('button', { name: '发送问题' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '停止生成' })).toBeEnabled())
    expect(textbox).toHaveValue('')

    await user.click(screen.getByRole('button', { name: '停止生成' }))

    expect(requestSignal.aborted).toBe(true)
    expect(screen.getByRole('button', { name: '发送问题' })).toBeDisabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('status', { name: '正在整理答案' })).not.toBeInTheDocument()

    await act(async () => {
      resolveSend(sseResponse({
        conversation: conversationA,
        userMessage: { ...priorMessage, id: 'MSG-CANCEL-U', role: 'USER', content: '需要中止的问题', answerStatus: null },
        assistantMessage: { ...priorMessage, id: 'MSG-CANCEL-A', content: '不应显示' },
      }))
      await pendingSend
    })
    expect(screen.queryByText('不应显示')).not.toBeInTheDocument()
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
    expect(document.querySelector('.archive-label')).toHaveTextContent('已归档')
    expect(fetchMock).toHaveBeenCalledWith('/api/chat/conversations/CVS-A/archive', expect.objectContaining({ method: 'POST' }))
  })

  it('finds archived conversations and restores the selected conversation', async () => {
    const user = userEvent.setup()
    const archivedConversation = { ...conversationA, id: 'CVS-C', title: '已归档项目', status: 'ARCHIVED' as const }
    const fetchMock = mockFetch((path, init) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA, archivedConversation] })
      if (path === '/api/chat/conversations/CVS-A') return jsonResponse(detail(conversationA))
      if (path === '/api/chat/conversations/CVS-C') return jsonResponse(detail(archivedConversation))
      if (path === '/api/chat/conversations/CVS-C/restore' && init?.method === 'POST') return jsonResponse({ conversation: conversationA })
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)
    expect(await screen.findByText('原有回答')).toBeInTheDocument()

    const archiveFilter = screen.getByRole('button', { name: /已归档/ })
    expect(archiveFilter).toHaveTextContent('1')
    await user.click(archiveFilter)
    expect(screen.getByRole('button', { name: '已归档项目' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '已归档项目' }))
    expect(await screen.findByRole('button', { name: '恢复当前会话' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '恢复当前会话' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat/conversations/CVS-C/restore',
      expect.objectContaining({ method: 'POST' }),
    ))
    expect(screen.getByRole('button', { name: '归档当前对话' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '问题' })).toBeEnabled()
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
    const topbar = document.querySelector('.assistant-topbar')
    expect(drawer).toHaveAttribute('id', 'source-drawer')
    expect(drawer).not.toHaveAttribute('aria-modal')
    expect(topbar).not.toHaveAttribute('inert')
    expect(screen.getByRole('button', { name: '退出登录' }).closest('[inert]')).toBeNull()
    expect(screen.getByLabelText('对话列表')).not.toHaveAttribute('inert')
    expect(document.querySelector('.chat-main')).not.toHaveAttribute('inert')
    expect(drawer).toHaveTextContent('飞书中的完整来源')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(fetchMock).toHaveBeenCalledWith('/api/citations/CIT-1', expect.any(Object))
    await user.click(screen.getByRole('button', { name: '关闭来源' }))
    expect(trigger).toHaveFocus()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('makes the source drawer modal and the background inert at the responsive breakpoint', async () => {
    const user = userEvent.setup()
    stubMatchMedia(true)
    mockFetch((path) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA] })
      if (path === '/api/chat/conversations/CVS-A') {
        return jsonResponse(detail(conversationA, [{ ...priorMessage, citations: [citation] }]))
      }
      if (path === '/api/citations/CIT-1') return jsonResponse(citation)
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)
    const topbar = document.querySelector('.assistant-topbar')
    const logoutButton = screen.getByRole('button', { name: '退出登录' })

    await user.click(await screen.findByRole('button', { name: '[1]' }))

    expect(await screen.findByRole('dialog', { name: '来源详情' })).toHaveAttribute('aria-modal', 'true')
    expect(topbar).toHaveAttribute('inert')
    expect(logoutButton.closest('[inert]')).toBe(topbar)
    expect(document.querySelector('.page-content')).not.toHaveAttribute('inert')
    expect(screen.getByLabelText('对话列表')).toHaveAttribute('inert')
    expect(document.querySelector('.chat-main')).toHaveAttribute('inert')
    expect(document.querySelector('.conversation-backdrop')).not.toHaveClass('is-open')
  })

  it('removes background inertness before restoring citation focus on mobile close', async () => {
    const user = userEvent.setup()
    stubMatchMedia(true)
    mockFetch((path) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA] })
      if (path === '/api/chat/conversations/CVS-A') {
        return jsonResponse(detail(conversationA, [{ ...priorMessage, citations: [citation] }]))
      }
      if (path === '/api/citations/CIT-1') return jsonResponse(citation)
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)
    const trigger = await screen.findByRole('button', { name: '[1]' })
    await user.click(trigger)
    await screen.findByRole('dialog', { name: '来源详情' })
    const chatMain = document.querySelector('.chat-main')
    const topbar = document.querySelector('.assistant-topbar')
    expect(chatMain).toHaveAttribute('inert')
    expect(topbar).toHaveAttribute('inert')
    let focusCalledWhileInert: boolean | undefined
    const focusTrigger = trigger.focus.bind(trigger)
    vi.spyOn(trigger, 'focus').mockImplementation(() => {
      focusCalledWhileInert = chatMain?.hasAttribute('inert')
      focusTrigger()
    })

    await user.click(screen.getByRole('button', { name: '关闭来源' }))

    expect(screen.getByLabelText('对话列表')).not.toHaveAttribute('inert')
    expect(chatMain).not.toHaveAttribute('inert')
    expect(topbar).not.toHaveAttribute('inert')
    expect(focusCalledWhileInert).toBe(false)
    expect(trigger).toHaveFocus()
  })

  it('moves focus into an open drawer when the responsive breakpoint becomes modal', async () => {
    const user = userEvent.setup()
    const mediaQuery = stubMatchMedia(false)
    mockFetch((path) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA] })
      if (path === '/api/chat/conversations/CVS-A') {
        return jsonResponse(detail(conversationA, [{ ...priorMessage, citations: [citation] }]))
      }
      if (path === '/api/citations/CIT-1') return jsonResponse(citation)
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)
    const trigger = await screen.findByRole('button', { name: '[1]' })
    await user.click(trigger)
    await screen.findByRole('dialog', { name: '来源详情' })
    const topbar = document.querySelector('.assistant-topbar')
    expect(topbar).not.toHaveAttribute('inert')
    trigger.focus()

    act(() => mediaQuery.setMatches(true))

    expect(screen.getByRole('dialog', { name: '来源详情' })).toHaveAttribute('aria-modal', 'true')
    expect(topbar).toHaveAttribute('inert')
    expect(screen.getByRole('button', { name: '关闭来源' })).toHaveFocus()
    await user.tab({ shift: true })
    expect(screen.getByRole('link', { name: '打开飞书原文' })).toHaveFocus()

    act(() => mediaQuery.setMatches(false))

    expect(screen.getByRole('dialog', { name: '来源详情' })).not.toHaveAttribute('aria-modal')
    expect(topbar).not.toHaveAttribute('inert')
  })

  it('removes the responsive breakpoint listener on unmount', () => {
    const mediaQuery = stubMatchMedia(false)
    emptyWorkspaceFetch()
    const { unmount } = render(<ChatPage />)
    const listener = mediaQuery.addEventListener.mock.calls[0]?.[1]

    expect(mediaQuery.addEventListener).toHaveBeenCalledWith('change', expect.any(Function))
    unmount()

    expect(mediaQuery.removeEventListener).toHaveBeenCalledWith('change', listener)
  })

  it('keeps the fixed three-column chat layout and static composer dock', () => {
    const appCss = readFileSync('src/styles/app.css', 'utf8')

    expect(appCss).toMatch(/\.chat-layout\s*\{[^}]*grid-template-columns:\s*220px minmax\(0, 1fr\)/s)
    expect(appCss).toMatch(/\.chat-layout\.source-open\s*\{[^}]*grid-template-columns:\s*220px minmax\(0, 1fr\) 320px/s)
    expect(appCss).toMatch(/\.chat-main\s*\{[^}]*grid-template-rows:\s*56px minmax\(0, 1fr\) auto/s)
    expect(appCss).toMatch(/\.chat-message-area\s*\{[^}]*position:\s*relative;[^}]*min-height:\s*0;/s)
    expect(appCss).toMatch(/\.chat-message-scroll\s*\{[^}]*overflow-y:\s*auto;[^}]*overflow-x:\s*hidden/s)
    expect(appCss).toMatch(/\.chat-scroll-to-bottom\s*\{[^}]*bottom:\s*16px;/s)
    expect(appCss).toMatch(/\.chat-composer-dock\s*\{[^}]*position:\s*static;[^}]*padding:\s*12px 24px 18px/s)
    expect(appCss).toMatch(/\.chat-composer textarea:focus-visible\s*\{[^}]*box-shadow:\s*none;/s)
    expect(appCss).toMatch(/\.conversation-sidebar,[^}]*\.source-drawer\s*\{[^}]*border-color:\s*transparent;[^}]*background:\s*#f4f8fd/s)
    expect(appCss).toMatch(/\.conversation-drawer-trigger,[^}]*\.conversation-backdrop\s*\{[^}]*display:\s*none;/s)
    expect(appCss).toMatch(/\.conversation-backdrop\.is-open\s*\{[^}]*display:\s*block;/s)
  })

  it('wraps long unbroken message and source tokens without widening the layout', () => {
    const appCss = readFileSync('src/styles/app.css', 'utf8')

    expect(appCss).toMatch(/\.message-bubble\s*\{[^}]*min-width:\s*0;/s)
    expect(appCss).toMatch(/\.message-bubble p\s*\{[^}]*overflow-wrap:\s*anywhere;/s)
    expect(appCss).toMatch(/\.source-drawer-content\s*\{[^}]*min-width:\s*0;/s)
    expect(appCss).toMatch(/\.source-drawer-content h3,[^}]*\.source-drawer-content p\s*\{[^}]*overflow-wrap:\s*anywhere;/s)
  })

  it('shows a bottom arrow only while the message area is scrolled away from the latest answer', async () => {
    const user = userEvent.setup()
    emptyWorkspaceFetch()
    render(<ChatPage />)
    await screen.findByText('开始一段新对话')
    const messageScroll = document.querySelector('.chat-message-scroll') as HTMLDivElement
    const scrollTo = vi.fn()
    Object.defineProperty(messageScroll, 'scrollHeight', { configurable: true, value: 1200 })
    Object.defineProperty(messageScroll, 'clientHeight', { configurable: true, value: 500 })
    Object.defineProperty(messageScroll, 'scrollTop', { configurable: true, writable: true, value: 0 })
    Object.defineProperty(messageScroll, 'scrollTo', { configurable: true, value: scrollTo })

    fireEvent.scroll(messageScroll)
    const scrollButton = await screen.findByRole('button', { name: '滚动到最新消息' })
    expect(scrollButton).toBeInTheDocument()

    await user.click(scrollButton)
    expect(scrollTo).toHaveBeenCalledWith({ top: 1200, behavior: 'smooth' })
    expect(screen.queryByRole('button', { name: '滚动到最新消息' })).not.toBeInTheDocument()

    Object.defineProperty(messageScroll, 'scrollTop', { configurable: true, writable: true, value: 700 })
    fireEvent.scroll(messageScroll)
    expect(screen.queryByRole('button', { name: '滚动到最新消息' })).not.toBeInTheDocument()
  })
})
