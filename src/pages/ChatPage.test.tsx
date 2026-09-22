/// <reference types="node" />

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProductAgentInterrupt, ProductCitation, ProductConversation, ProductMaterial, ProductMessage } from '../../shared/api/product.js'
import { ChatPage, displayClarificationAnswer } from './ChatPage'

const logout = vi.fn(async () => undefined)
const reloadSession = vi.fn(async () => undefined)

vi.mock('../session/SessionProvider', () => ({
  useSession: () => ({
    user: { id: 'USR-1', name: '陈晨', avatarUrl: null },
    status: 'authenticated',
    logout,
    reload: reloadSession,
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
  reloadSession.mockClear()
  vi.unstubAllGlobals()
  const browserNavigator = navigator as unknown as { share?: unknown; canShare?: unknown }
  delete browserNavigator.share
  delete browserNavigator.canShare
  logout.mockClear()
})

describe('ChatPage product workspace', () => {
  it('renders clarification labels for case variants and serialized multi-select ids', () => {
    const interrupt: ProductAgentInterrupt = {
      question: '首期需要哪些能力？',
      questionId: 'FEATURES',
      type: 'MULTIPLE_CHOICE',
      options: [
        { id: 'user_app', label: '用户端' },
        { id: 'transaction', label: '购物车、下单和支付' },
      ],
      questions: [{
        id: 'FEATURES',
        questionId: 'FEATURES',
        question: '首期需要哪些能力？',
        type: 'MULTIPLE_CHOICE',
        options: [
          { id: 'user_app', label: '用户端' },
          { id: 'transaction', label: '购物车、下单和支付' },
        ],
      }],
      status: 'INTERRUPTED',
    }

    expect(displayClarificationAnswer('Confirmed', interrupt)).toBe('已确定')
    expect(displayClarificationAnswer(['USER_APP', 'TRANSACTION'], interrupt)).toBe('用户端、购物车、下单和支付')
    expect(displayClarificationAnswer('["user_app","transaction"]', interrupt)).toBe('用户端、购物车、下单和支付')
  })

  it('refreshes the product session instead of showing a conversation error after authentication expires', async () => {
    mockFetch((path) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA] })
      if (path === '/api/chat/conversations/CVS-A') {
        return jsonResponse({ error: { code: 'LOGIN_REQUIRED', message: '请使用飞书登录' } }, 401)
      }
      throw new Error(`Unexpected request: ${path}`)
    })

    render(<ChatPage />)

    await waitFor(() => expect(reloadSession).toHaveBeenCalledTimes(1))
    expect(screen.queryByText('会话加载失败，请重试')).not.toBeInTheDocument()
  })

  it('shows an empty workspace without technical controls', async () => {
    emptyWorkspaceFetch()

    render(<ChatPage />)

    const productHeading = await screen.findByRole('heading', { level: 1, name: '企业知识助手' })
    expect(productHeading).toBeInTheDocument()
    expect(productHeading.closest('.assistant-brand')?.querySelector('img')).toHaveAttribute('src', '/quickdone-mark.webp')
    expect(screen.getByRole('heading', { level: 2, name: '让每一次工作协作，都从一个对话开始。' })).toBeInTheDocument()
    expect(screen.getByText('统一对话入口 · 企业知识助手')).toBeInTheDocument()
    expect(screen.getByText('默认能力 · 直接问答')).toBeInTheDocument()
    expect(screen.getByText('需要查资料、做方案或整理会议纪要时，AI 会自动调用合适技能；也可以输入 @ 手动选择。')).toBeInTheDocument()
    expect(screen.queryByText(/像原来一样直接提问/u)).not.toBeInTheDocument()
    expect(document.querySelector('.prototype-skill-strip')?.nextElementSibling).toHaveClass('prototype-skill-hint')
    expect(screen.getByRole('button', { name: '选择查资料' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '选择做方案 / 汇报' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '选择会议纪要' })).toBeInTheDocument()
    expect(screen.getByText('可以这样问')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '投标一体机定价体系' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '语音智控的技术架构' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '回答方式' })).toHaveValue('CONCISE')
    expect(screen.getByText('资料原文只存放在飞书知识库，助手不会复制到其他位置')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '问题' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新对话' })).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent(/上传资料|回答范围|Factory|Knowledge Factory|Yuxi|模型|Agent|智能体|Skill/iu)
  })

  it('selects a skill directly from the new conversation guide', async () => {
    const user = userEvent.setup()
    emptyWorkspaceFetch()
    render(<ChatPage />)

    await user.click(await screen.findByRole('button', { name: '选择查资料' }))

    expect(screen.getByRole('textbox', { name: '问题' })).toHaveValue('@查资料 ')
    expect(document.querySelector('.composer-skill-token')).toHaveTextContent('@查资料')
  })

  it('does not add a duplicate skill when the same skill is selected again', async () => {
    const user = userEvent.setup()
    emptyWorkspaceFetch()
    render(<ChatPage />)

    await user.click(await screen.findByRole('button', { name: '选择查资料' }))
    await user.click(screen.getByRole('button', { name: '选择查资料' }))

    const textbox = screen.getByRole('textbox', { name: '问题' })
    expect(textbox).toHaveValue('@查资料 ')
  })

  it('replaces the selected skill when switching skills and preserves the request', async () => {
    const user = userEvent.setup()
    emptyWorkspaceFetch()
    render(<ChatPage />)

    await user.click(await screen.findByRole('button', { name: '选择查资料' }))
    const textbox = screen.getByRole('textbox', { name: '问题' })
    await user.type(textbox, '找产品说明')
    await user.click(screen.getByRole('button', { name: '选择做方案 / 汇报' }))

    expect(textbox).toHaveValue('@做方案 找产品说明')
    expect(textbox).not.toHaveValue(expect.stringContaining('@查资料'))
  })

  it('cleans up an old skill and an in-progress skill search when switching skills', async () => {
    const user = userEvent.setup()
    emptyWorkspaceFetch()
    render(<ChatPage />)

    await user.click(await screen.findByRole('button', { name: '选择查资料' }))
    const textbox = screen.getByRole('textbox', { name: '问题' })
    await user.type(textbox, '找产品说明 @做')
    await user.click(screen.getByRole('option', { name: /@做方案/u }))

    expect(textbox).toHaveValue('@做方案 找产品说明 ')
    expect(textbox).not.toHaveValue(expect.stringContaining('@查资料'))
  })

  it('filters historical conversations from the sidebar search', async () => {
    const user = userEvent.setup()
    mockFetch((path) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA, conversationB] })
      if (path === '/api/chat/conversations/CVS-A') return jsonResponse(detail(conversationA))
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)

    await screen.findByText('原有回答')
    const search = screen.getByRole('searchbox', { name: '搜索历史会话' })
    expect(screen.getByRole('button', { name: '项目 A' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '项目 B' })).toBeInTheDocument()

    await user.type(search, '项目 B')

    expect(screen.queryByRole('button', { name: '项目 A' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '项目 B' })).toBeInTheDocument()
    expect(screen.queryByText('未找到匹配的会话')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '清除会话搜索' }))
    expect(screen.getByRole('button', { name: '项目 A' })).toBeInTheDocument()
  })

  it('shows a fallback label when a historical conversation has no title', async () => {
    const unnamedConversation: ProductConversation = {
      ...conversationA,
      id: 'CVS-EMPTY-TITLE',
      title: '  ',
      updatedAt: '2026-08-12T02:00:00.000Z',
    }
    mockFetch((path) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [unnamedConversation] })
      if (path === '/api/chat/conversations/CVS-EMPTY-TITLE') return jsonResponse(detail(unnamedConversation))
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)

    await screen.findByText('原有回答')
    expect(screen.getByRole('button', { name: '未命名会话' })).toBeInTheDocument()
  })

  it('fills the composer with an example question and keeps fast mode selected', async () => {
    const user = userEvent.setup()
    emptyWorkspaceFetch()
    render(<ChatPage />)

    await screen.findByRole('heading', { level: 2, name: '让每一次工作协作，都从一个对话开始。' })
    await user.click(screen.getByRole('button', { name: '投标一体机定价体系' }))

    expect(screen.getByRole('textbox', { name: '问题' })).toHaveValue('投标一体机定价体系')
    expect(screen.getByRole('combobox', { name: '回答方式' })).toHaveValue('CONCISE')
  })

  it('keeps the selected skill marker so the user can type the requirement after it', async () => {
    const user = userEvent.setup()
    emptyWorkspaceFetch()
    render(<ChatPage />)

    await screen.findByRole('heading', { level: 2, name: '让每一次工作协作，都从一个对话开始。' })
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

    await screen.findByRole('heading', { level: 2, name: '让每一次工作协作，都从一个对话开始。' })
    const textbox = screen.getByRole('textbox', { name: '问题' })
    await user.type(textbox, '请帮我 @查')
    await user.click(screen.getByRole('option', { name: /@查资料/u }))

    expect(textbox).toHaveValue('请帮我 @查资料 ')
  })

  it('removes a selected skill atomically and clears its active state', async () => {
    const user = userEvent.setup()
    emptyWorkspaceFetch()
    render(<ChatPage />)

    await screen.findByRole('heading', { level: 2, name: '让每一次工作协作，都从一个对话开始。' })
    const textbox = screen.getByRole('textbox', { name: '问题' }) as HTMLTextAreaElement
    await user.type(textbox, '@查')
    await user.click(screen.getByRole('option', { name: /@查资料/u }))
    expect(document.querySelector('.composer-skill-token')).toHaveTextContent('@查资料')

    textbox.setSelectionRange('@查资料 '.length, '@查资料 '.length)
    fireEvent.keyDown(textbox, { key: 'Backspace' })

    expect(textbox).toHaveValue('')
    expect(document.querySelector('.composer-skill-token')).toBeNull()
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
    const streamCall = fetchMock.mock.calls.find(([path, init]) => (
      path === `/api/chat/conversations/${createdConversation.id}/messages/stream` && init?.method === 'POST'
    ))
    expect(JSON.parse(String(streamCall?.[1]?.body))).toMatchObject({
      content: '@查资料 找产品说明',
      mode: 'DETAILED',
      skillId: 'MATERIAL_SEARCH',
    })
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

    expect(screen.getByRole('heading', { level: 2, name: '让每一次工作协作，都从一个对话开始。' })).toBeInTheDocument()
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
    expect(screen.getByRole('heading', { level: 2, name: '让每一次工作协作，都从一个对话开始。' })).toBeInTheDocument()
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

  it('keeps answer mode controls hidden when starting a new conversation', async () => {
    const user = userEvent.setup()
    mockFetch((path) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA] })
      if (path === '/api/chat/conversations/CVS-A') return jsonResponse(detail(conversationA))
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)
    expect(await screen.findByText('原有回答')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '新对话' }))

    expect(screen.getByRole('combobox', { name: '回答方式' })).toHaveValue('CONCISE')
  })

  it('manages focus and keyboard dismissal for the conversation drawer', async () => {
    const user = userEvent.setup()
    emptyWorkspaceFetch()
    render(<ChatPage />)
    await screen.findByRole('heading', { level: 2, name: '让每一次工作协作，都从一个对话开始。' })
    const trigger = screen.getByRole('button', { name: '打开对话列表' })

    expect(trigger).toHaveAttribute('aria-controls', 'conversation-sidebar')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await user.click(trigger)

    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const close = within(screen.getByLabelText('对话列表')).getByRole('button', { name: '关闭对话列表' })
    await waitFor(() => expect(close).toHaveFocus())
    await user.tab({ shift: true })
    expect(screen.getByRole('button', { name: '后台任务' })).toHaveFocus()
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
    const streamCall = fetchMock.mock.calls.find(([path, init]) => (
      path === '/api/chat/conversations/CVS-A/messages/stream' && init?.method === 'POST'
    ))
    expect(JSON.parse(String(streamCall?.[1]?.body))).toMatchObject({
      content: '上线条件是什么？',
      mode: 'CONCISE',
    })
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

    const modeSelect = screen.getByRole('combobox', { name: '回答方式' })
    await user.selectOptions(modeSelect, 'DETAILED')
    await user.type(screen.getByRole('textbox', { name: '问题' }), '给出完整实施说明')
    await user.click(screen.getByRole('button', { name: '发送问题' }))

    await waitFor(() => {
      const streamCall = fetchMock.mock.calls.find(([path, init]) => (
        path === '/api/chat/conversations/CVS-A/messages/stream' && init?.method === 'POST'
      ))
      expect(JSON.parse(String(streamCall?.[1]?.body))).toMatchObject({
        content: '给出完整实施说明',
        mode: 'DETAILED',
      })
    })
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
    const streamCall = fetchMock.mock.calls.find(([path, init]) => (
      path === '/api/chat/conversations/CVS-A/messages/stream' && init?.method === 'POST'
    ))
    expect(JSON.parse(String(streamCall?.[1]?.body))).toMatchObject({
      content: '请结合方案回答',
      mode: 'CONCISE',
      attachmentIds: ['ATT-1'],
    })
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
        + 'event: progress\ndata: {"stage":"RETRIEVING","message":"核验后正在补充检索资料"}\n\n'
        + 'event: progress\ndata: {"stage":"COMPOSING","message":"正在整理结论和可核验来源"}\n\n'
        + 'event: delta\ndata: {"content":"## 结论\\n\\n支持"}\n\n',
      ))
    })

    expect(await screen.findByRole('heading', { level: 2, name: '结论' })).toBeInTheDocument()
    expect(screen.getByText('支持')).toBeInTheDocument()
    expect(within(screen.getByLabelText('消息线程')).getByRole('status')).toHaveTextContent('正在生成')
    await user.click(screen.getByRole('button', { name: '查看执行过程' }))
    expect([...document.querySelectorAll('.message-streaming .thinking-step strong')].map((item) => item.textContent)).toEqual([
      '理解问题', '检索资料', '核对依据', '检索资料', '组织答案',
    ])
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

  it('keeps the solution execution process visible after a stream failure', async () => {
    const user = userEvent.setup()
    mockFetch((path, init) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA] })
      if (path === '/api/chat/conversations/CVS-A' && !init?.method) return jsonResponse(detail(conversationA))
      if (path === '/api/chat/conversations/CVS-A/messages/stream') {
        return new Response([
          'event: run_started\ndata: {"runId":"RUN-FAILED"}\n\n',
          'event: progress\ndata: {"stage":"REQUIREMENTS_ANALYSIS","message":"正在拆解客户需求"}\n\n',
          'event: progress\ndata: {"stage":"COMPOSING","message":"正在整理方案"}\n\n',
          'event: error\ndata: {"code":"AGENT_RUN_PROJECTION_FAILED","message":"方案草稿保存失败，请重试"}\n\n',
        ].join(''), { headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)
    expect(await screen.findByText('原有回答')).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: '问题' }), '@做方案 设计商城方案')
    await user.click(screen.getByRole('button', { name: '发送问题' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('方案草稿保存失败，请重试')
    expect(screen.getByRole('status', { name: '执行过程' })).toHaveTextContent('生成失败')
    expect(document.querySelector('.message-pending-question')).toHaveTextContent('设计商城方案')
    await user.click(screen.getByRole('button', { name: '查看执行过程' }))
    expect(document.querySelector('.thinking-steps')).toHaveTextContent('正在拆解客户需求')
    expect(document.querySelector('.thinking-steps')).toHaveTextContent('正在整理方案')
    expect(document.querySelector('.thinking-spinner')).toBeNull()
  })

  it('shows progress immediately when continuing a historical draft and retains it on failure', async () => {
    const user = userEvent.setup()
    let resolveResume!: (response: Response) => void
    const pendingResume = new Promise<Response>((resolve) => { resolveResume = resolve })
    const historical: ProductMessage = {
      ...priorMessage,
      skillId: 'SOLUTION_DRAFT',
      solutionDraft: {
        id: 'DRAFT-OLD', conversationId: conversationA.id, sourceRunId: 'RUN-OLD', currentVersion: 1,
        status: 'BLOCKED', title: '商城方案', customerContext: '商城', executiveSummary: '初步方案',
        requirements: [], sections: [], assumptions: [], openQuestions: [], risks: [], conflicts: [], evidenceGaps: [], citations: [],
        quality: { status: 'BLOCKED', evidenceCoverage: 0, missingSections: [], invalidCitations: [], notes: [] },
        clarificationQuestions: [{ id: 'INDUSTRY', question: '请选择客户行业', type: 'SINGLE_CHOICE', options: [{ id: 'retail', label: '零售行业' }], required: true, allowSkip: true, position: 1, total: 1 }],
        createdAt: conversationA.createdAt, updatedAt: conversationA.updatedAt,
      },
    }
    mockFetch((path, init) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA] })
      if (path === '/api/chat/conversations/CVS-A' && !init?.method) return jsonResponse(detail(conversationA, [historical]))
      if (path.endsWith('/active-run')) return jsonResponse({ run: null })
      if (path === '/api/chat/runs/RUN-OLD/resume') return pendingResume
      if (path === '/api/chat/runs/RUN-NEW/events') {
        return new Response('event: error\ndata: {"code":"AGENT_RUN_PROJECTION_FAILED","message":"方案草稿保存失败，请重试"}\n\n', { headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)
    await user.click(await screen.findByRole('button', { name: '零售行业' }))
    await user.click(screen.getByRole('button', { name: '提交并继续' }))

    expect(screen.getByRole('status', { name: '执行过程' })).toHaveTextContent('正在吸收补充信息，重新分析需求')
    expect(document.querySelector('.message-pending-question')).toHaveTextContent('零售行业')
    expect(screen.getByRole('button', { name: '停止生成' })).toBeEnabled()
    await act(async () => { resolveResume(jsonResponse({ run: { runId: 'RUN-NEW' } })) })

    expect(await screen.findByRole('alert')).toHaveTextContent('方案草稿保存失败，请重试')
    expect(screen.getByRole('status', { name: '执行过程' })).toHaveTextContent('生成失败')
    expect(document.querySelector('.thinking-spinner')).toBeNull()
  })

  it('resumes a legacy openQuestions draft instead of silently returning', async () => {
    const user = userEvent.setup()
    let resolveResume!: (response: Response) => void
    const pendingResume = new Promise<Response>((resolve) => { resolveResume = resolve })
    const historical: ProductMessage = {
      ...priorMessage,
      id: 'MSG-LEGACY-OPEN-RESUME',
      skillId: 'SOLUTION_DRAFT',
      solutionDraft: {
        id: 'DRAFT-LEGACY-OPEN-RESUME',
        conversationId: conversationA.id,
        sourceRunId: 'RUN-LEGACY-OPEN',
        currentVersion: 1,
        status: 'BLOCKED',
        title: '商城方案',
        customerContext: '宠物用品商城',
        executiveSummary: '待补充部署方式后继续生成。',
        requirements: [],
        sections: [],
        assumptions: [],
        openQuestions: ['方案预计采用哪种部署方式？'],
        risks: [],
        conflicts: [],
        evidenceGaps: [],
        citations: [],
        quality: { status: 'BLOCKED', evidenceCoverage: 0, missingSections: [], invalidCitations: [], notes: [] },
        clarificationQuestionsResolved: false,
        createdAt: conversationA.createdAt,
        updatedAt: conversationA.updatedAt,
      },
    }
    const fetchMock = mockFetch((path, init) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA] })
      if (path === '/api/chat/conversations/CVS-A' && !init?.method) return jsonResponse(detail(conversationA, [historical]))
      if (path.endsWith('/active-run')) return jsonResponse({ run: null })
      if (path === '/api/chat/runs/RUN-LEGACY-OPEN/resume') return pendingResume
      if (path === '/api/chat/runs/RUN-LEGACY-OPEN-NEW/events') {
        return sseResponse({
          conversation: { ...conversationA, messageCount: 3 },
          userMessage: { ...priorMessage, id: 'MSG-LEGACY-OPEN-U', role: 'USER', content: '私有化部署', answerStatus: null },
          assistantMessage: { ...priorMessage, id: 'MSG-LEGACY-OPEN-A', role: 'ASSISTANT', content: '已继续生成方案。', answerStatus: 'SUPPORTED' },
        })
      }
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)

    await user.click(await screen.findByRole('button', { name: '私有化部署' }))
    await user.click(screen.getByRole('button', { name: '提交并继续' }))

    // The request must be sent and visible progress must start immediately,
    // even while the resume endpoint is still waiting for the next run id.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat/runs/RUN-LEGACY-OPEN/resume',
      expect.objectContaining({ method: 'POST' }),
    ))
    expect(screen.getByRole('status', { name: '执行过程' })).toHaveTextContent('正在吸收补充信息，重新分析需求')
    expect(screen.getByText('已提交，正在继续生成方案…')).toBeInTheDocument()
    expect(document.querySelector('.message-pending-question')).toHaveTextContent('私有化部署')

    // Avoid leaving the intentionally pending request around in the test.
    await act(async () => { resolveResume(jsonResponse({ run: { runId: 'RUN-LEGACY-OPEN-NEW' } })) })
  })

  it('resumes a legacy requirements-only draft with the recovered scope choices', async () => {
    const user = userEvent.setup()
    const historical: ProductMessage = {
      ...priorMessage,
      id: 'MSG-LEGACY-REQUIREMENT-RESUME',
      skillId: 'SOLUTION_DRAFT',
      solutionDraft: {
        id: 'DRAFT-LEGACY-REQUIREMENT-RESUME',
        conversationId: conversationA.id,
        sourceRunId: 'RUN-LEGACY-REQUIREMENT',
        currentVersion: 1,
        status: 'BLOCKED',
        title: '宠物用品商城方案',
        customerContext: '建设宠物用品电子商城',
        executiveSummary: '待补充首期范围后继续生成。',
        requirements: [{
          id: 'REQ-SCOPE',
          text: '建议纳入首期范围：微信小程序首页、商品分类；购物车、下单和支付。',
          source: '需求分析，待确认',
        }],
        sections: [],
        assumptions: [],
        openQuestions: [],
        risks: [],
        conflicts: [],
        evidenceGaps: [],
        citations: [],
        quality: { status: 'BLOCKED', evidenceCoverage: 0, missingSections: [], invalidCitations: [], notes: [] },
        clarificationQuestionsResolved: false,
        createdAt: conversationA.createdAt,
        updatedAt: conversationA.updatedAt,
      },
    }
    const fetchMock = mockFetch((path, init) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA] })
      if (path === '/api/chat/conversations/CVS-A' && !init?.method) return jsonResponse(detail(conversationA, [historical]))
      if (path.endsWith('/active-run')) return jsonResponse({ run: null })
      if (path === '/api/chat/runs/RUN-LEGACY-REQUIREMENT/resume') {
        return jsonResponse({ run: { runId: 'RUN-LEGACY-REQUIREMENT-NEW', streamUrl: '/api/chat/runs/RUN-LEGACY-REQUIREMENT-NEW/events' } })
      }
      if (path === '/api/chat/runs/RUN-LEGACY-REQUIREMENT-NEW/events') {
        return sseResponse({
          conversation: { ...conversationA, messageCount: 3 },
          userMessage: { ...priorMessage, id: 'MSG-LEGACY-REQUIREMENT-U', role: 'USER', content: 'SCOPE_1', answerStatus: null },
          assistantMessage: { ...priorMessage, id: 'MSG-LEGACY-REQUIREMENT-A', role: 'ASSISTANT', content: '已继续生成方案。', answerStatus: 'SUPPORTED' },
        })
      }
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)

    await user.click(await screen.findByRole('button', { name: '微信小程序首页、商品分类' }))
    await user.click(screen.getByRole('button', { name: '提交并继续' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat/runs/RUN-LEGACY-REQUIREMENT/resume',
      expect.objectContaining({ method: 'POST' }),
    ))
    const resumeCall = fetchMock.mock.calls.find(([path]) => path === '/api/chat/runs/RUN-LEGACY-REQUIREMENT/resume')
    expect(resumeCall?.[1]?.body).toEqual(expect.stringContaining('SCOPE_1'))
    expect(await screen.findByText('已继续生成方案。')).toBeInTheDocument()
  })

  it('keeps a historical clarification available when active-run lookup is temporarily unavailable', async () => {
    const historical: ProductMessage = {
      ...priorMessage,
      skillId: 'SOLUTION_DRAFT',
      solutionDraft: {
        id: 'DRAFT-RETRY-ACTIVE-RUN', conversationId: conversationA.id, sourceRunId: 'RUN-HISTORY-RETRY', currentVersion: 1,
        status: 'BLOCKED', title: '商城方案', customerContext: '商城', executiveSummary: '初步方案',
        requirements: [], sections: [], assumptions: [], openQuestions: [], risks: [], conflicts: [], evidenceGaps: [], citations: [],
        quality: { status: 'BLOCKED', evidenceCoverage: 0, missingSections: [], invalidCitations: [], notes: [] },
        clarificationQuestions: [{
          id: 'SCOPE', question: '首期范围是否已经确定？', type: 'SINGLE_CHOICE',
          options: [{ id: 'MVP', label: '已确定为 MVP' }], required: true, allowSkip: true, position: 1, total: 1,
        }],
        clarificationQuestionsResolved: false,
        createdAt: conversationA.createdAt, updatedAt: conversationA.updatedAt,
      },
    }
    mockFetch((path, init) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA] })
      if (path === '/api/chat/conversations/CVS-A' && !init?.method) return jsonResponse(detail(conversationA, [historical]))
      if (path.endsWith('/active-run')) return jsonResponse({ error: { code: 'YUXI_UNAVAILABLE', message: '暂时不可用' } }, 503)
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)

    expect(await screen.findByRole('button', { name: '已确定为 MVP' })).toBeInTheDocument()
    expect(screen.queryByText('会话加载失败，请重试')).not.toBeInTheDocument()
  })

  it('renders a clarification label instead of the internal option id after resume', async () => {
    const user = userEvent.setup()
    const historical: ProductMessage = {
      ...priorMessage,
      skillId: 'SOLUTION_DRAFT',
      content: '商城方案草稿',
      solutionDraft: {
        id: 'DRAFT-LABEL', conversationId: conversationA.id, sourceRunId: 'RUN-LABEL', currentVersion: 1,
        status: 'BLOCKED', title: '商城方案', customerContext: '商城', executiveSummary: '初步方案',
        requirements: [], sections: [], assumptions: [], openQuestions: [], risks: [], conflicts: [], evidenceGaps: [], citations: [],
        quality: { status: 'BLOCKED', evidenceCoverage: 0, missingSections: [], invalidCitations: [], notes: [] },
        clarificationQuestions: [{
          id: 'CUSTOMER', question: '客户主体和商城运营主体是否已经确定？', type: 'SINGLE_CHOICE',
          options: [{ id: 'confirmed', label: '已确定' }], required: true, allowSkip: true, position: 1, total: 1,
        }],
        createdAt: conversationA.createdAt, updatedAt: conversationA.updatedAt,
      },
    }
    const rawUserMessage: ProductMessage = {
      ...priorMessage,
      id: 'MSG-LABEL-U',
      role: 'USER',
      content: 'confirmed',
      answerStatus: null,
    }
    const assistantMessage: ProductMessage = {
      ...priorMessage,
      id: 'MSG-LABEL-A',
      role: 'ASSISTANT',
      content: '正式方案已生成。',
      answerStatus: 'SUPPORTED',
    }
    mockFetch((path, init) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA] })
      if (path === '/api/chat/conversations/CVS-A' && !init?.method) return jsonResponse(detail(conversationA, [historical]))
      if (path.endsWith('/active-run')) return jsonResponse({ run: null })
      if (path === '/api/chat/runs/RUN-LABEL/resume') return jsonResponse({ run: { runId: 'RUN-LABEL-RESUMED' } })
      if (path === '/api/chat/runs/RUN-LABEL-RESUMED/events') {
        return sseResponse({
          conversation: { ...conversationA, messageCount: 3 },
          userMessage: rawUserMessage,
          assistantMessage,
        })
      }
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)

    await user.click(await screen.findByRole('button', { name: /已确定/ }))
    await user.click(screen.getByRole('button', { name: '提交并继续' }))

    expect(await screen.findByText('正式方案已生成。')).toBeInTheDocument()
    expect(screen.getAllByText('已确定').length).toBeGreaterThan(0)
    expect(screen.queryByText('confirmed')).not.toBeInTheDocument()
  })

  it('normalizes persisted clarification ids when loading a historical conversation', async () => {
    const draftMessage = (
      id: string,
      questions: NonNullable<ProductMessage['solutionDraft']>['clarificationQuestions'],
    ): ProductMessage => ({
      ...priorMessage,
      id,
      role: 'ASSISTANT',
      content: '方案草稿',
      skillId: 'SOLUTION_DRAFT',
      solutionDraft: {
        id: `DRAFT-${id}`,
        conversationId: conversationA.id,
        currentVersion: 1,
        status: 'BLOCKED',
        title: '方案草稿',
        customerContext: '客户场景',
        executiveSummary: '初步方案',
        requirements: [],
        sections: [],
        assumptions: [],
        openQuestions: [],
        risks: [],
        conflicts: [],
        evidenceGaps: [],
        citations: [],
        quality: { status: 'BLOCKED', evidenceCoverage: 0, missingSections: [], invalidCitations: [], notes: [] },
        clarificationQuestions: questions,
        clarificationQuestionsResolved: false,
        createdAt: conversationA.createdAt,
        updatedAt: conversationA.updatedAt,
      },
    })
    const userMessage = (id: string, content: string): ProductMessage => ({
      ...priorMessage,
      id,
      role: 'USER',
      content,
      answerStatus: null,
    })
    const plainAssistant = (id: string): ProductMessage => ({
      ...priorMessage,
      id,
      role: 'ASSISTANT',
      content: '已记录补充信息。',
    })
    const messages: ProductMessage[] = [
      draftMessage('MSG-HISTORY-CONFIRMED-DRAFT', [{
        id: 'CUSTOMER',
        question: '客户主体是否已经确定？',
        type: 'SINGLE_CHOICE',
        options: [{ id: 'confirmed', label: '已确定' }],
        required: true,
        allowSkip: true,
        position: 1,
        total: 1,
      }]),
      userMessage('MSG-HISTORY-CONFIRMED', 'confirmed'),
      plainAssistant('MSG-HISTORY-CONFIRMED-A'),
      draftMessage('MSG-HISTORY-CUSTOM-DRAFT', [{
        id: 'SCOPE',
        question: '方案范围如何定义？',
        type: 'SINGLE_CHOICE',
        options: [{ id: 'custom_scope', label: '定制范围' }],
        required: true,
        allowSkip: true,
        position: 1,
        total: 1,
      }]),
      userMessage('MSG-HISTORY-CUSTOM', 'custom_scope'),
      plainAssistant('MSG-HISTORY-CUSTOM-A'),
      draftMessage('MSG-HISTORY-UNKNOWN-DRAFT', [{
        id: 'UNKNOWN',
        question: '其他条件？',
        type: 'SINGLE_CHOICE',
        options: [{ id: 'known', label: '已知选项' }],
        required: true,
        allowSkip: true,
        position: 1,
        total: 1,
      }]),
      userMessage('MSG-HISTORY-UNKNOWN', 'future_option'),
      plainAssistant('MSG-HISTORY-UNKNOWN-A'),
      draftMessage('MSG-HISTORY-MULTI-DRAFT', [{
        id: 'FEATURES',
        question: '首期需要哪些能力？',
        type: 'MULTIPLE_CHOICE',
        options: [
          { id: 'user_app', label: '用户端' },
          { id: 'transaction', label: '购物车、下单和支付' },
        ],
        required: true,
        allowSkip: true,
        position: 1,
        total: 1,
      }]),
      userMessage('MSG-HISTORY-MULTI', 'user_app、transaction'),
    ]
    mockFetch((path, init) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA] })
      if (path === '/api/chat/conversations/CVS-A' && !init?.method) return jsonResponse(detail(conversationA, messages))
      if (path.endsWith('/active-run')) return jsonResponse({ run: null })
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)

    expect(await screen.findByText('已确定')).toBeInTheDocument()
    expect(screen.getByText('定制范围')).toBeInTheDocument()
    expect(screen.getByText('future_option')).toBeInTheDocument()
    expect(screen.getByText('用户端、购物车、下单和支付')).toBeInTheDocument()
    expect(screen.queryByText('confirmed')).not.toBeInTheDocument()
    expect(screen.queryByText('custom_scope')).not.toBeInTheDocument()
    expect(screen.queryByText('user_app、transaction')).not.toBeInTheDocument()
  })

  it('renders historical batch answer keys case-insensitively without exposing internal ids', async () => {
    const questions: NonNullable<ProductMessage['solutionDraft']>['clarificationQuestions'] = [
      {
        id: 'SCOPE',
        question: '首期范围是否已经确定？',
        type: 'SINGLE_CHOICE',
        options: [{ id: 'confirmed', label: '已确定' }],
        required: true,
        allowSkip: true,
        position: 1,
        total: 2,
      },
      {
        id: 'ADMIN',
        question: '是否需要运营管理端？',
        type: 'SINGLE_CHOICE',
        options: [{ id: 'enabled', label: '需要' }],
        required: true,
        allowSkip: true,
        position: 2,
        total: 2,
      },
    ]
    const blockedDraft = (id: string): ProductMessage => ({
      ...priorMessage,
      id,
      role: 'ASSISTANT',
      content: '方案草稿',
      skillId: 'SOLUTION_DRAFT',
      solutionDraft: {
        id: `DRAFT-${id}`,
        conversationId: conversationA.id,
        currentVersion: 1,
        status: 'BLOCKED',
        title: '方案草稿',
        customerContext: '客户场景',
        executiveSummary: '初步方案',
        requirements: [],
        sections: [],
        assumptions: [],
        openQuestions: [],
        risks: [],
        conflicts: [],
        evidenceGaps: [],
        citations: [],
        quality: { status: 'BLOCKED', evidenceCoverage: 0, missingSections: [], invalidCitations: [], notes: [] },
        clarificationQuestions: questions,
        clarificationQuestionsResolved: false,
        createdAt: conversationA.createdAt,
        updatedAt: conversationA.updatedAt,
      },
    })
    const userMessage = (id: string, content: string): ProductMessage => ({
      ...priorMessage,
      id,
      role: 'USER',
      content,
      answerStatus: null,
    })
    const messages: ProductMessage[] = [
      blockedDraft('MSG-BATCH-JSON-DRAFT'),
      userMessage('MSG-BATCH-JSON', '{"scope":"CONFIRMED","admin":"ENABLED"}'),
      { ...priorMessage, id: 'MSG-BATCH-JSON-A', content: '已记录批量信息。' },
      blockedDraft('MSG-BATCH-SUPPLEMENT-DRAFT'),
      userMessage('MSG-BATCH-SUPPLEMENT', '继续设计\n\n补充信息：\nscope: confirmed\nADMIN：enabled'),
      { ...priorMessage, id: 'MSG-BATCH-SUPPLEMENT-A', content: '已记录补充信息。' },
    ]
    mockFetch((path, init) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA] })
      if (path === '/api/chat/conversations/CVS-A' && !init?.method) return jsonResponse(detail(conversationA, messages))
      if (path.endsWith('/active-run')) return jsonResponse({ run: null })
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)

    await screen.findByText('已记录补充信息。')
    const userReplies = [...document.querySelectorAll<HTMLElement>('.message-user p')]
      .map((element) => element.textContent)
    expect(userReplies).toContain('首期范围是否已经确定？：已确定\n是否需要运营管理端？：需要')
    expect(userReplies).toContain('继续设计\n\n补充信息：\n首期范围是否已经确定？: 已确定\n是否需要运营管理端？：需要')
    expect(document.body).not.toHaveTextContent(/(?:scope|admin)\s*[：:]/iu)
    expect(document.body).not.toHaveTextContent(/\b(?:confirmed|enabled)\b/iu)
  })

  it('normalizes standalone legacy clarification ids even when question metadata is absent', async () => {
    const messages: ProductMessage[] = [
      priorMessage,
      {
        ...priorMessage,
        id: 'MSG-STANDALONE-CONFIRMED',
        role: 'USER',
        content: 'Confirmed',
        answerStatus: null,
      },
      {
        ...priorMessage,
        id: 'MSG-STANDALONE-CONFIRMED-A',
        role: 'ASSISTANT',
        content: '已记录。',
      },
      {
        ...priorMessage,
        id: 'MSG-STANDALONE-MULTI',
        role: 'USER',
        content: 'user_app、TRANSACTION',
        answerStatus: null,
      },
      {
        ...priorMessage,
        id: 'MSG-STANDALONE-MULTI-A',
        role: 'ASSISTANT',
        content: '已记录多选项。',
      },
      {
        ...priorMessage,
        id: 'MSG-STANDALONE-PROSE',
        role: 'USER',
        content: 'please use admin for this area',
        answerStatus: null,
      },
      {
        ...priorMessage,
        id: 'MSG-STANDALONE-PROSE-A',
        role: 'ASSISTANT',
        content: '已记录说明。',
      },
    ]
    mockFetch((path, init) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA] })
      if (path === '/api/chat/conversations/CVS-A' && !init?.method) return jsonResponse(detail(conversationA, messages))
      if (path.endsWith('/active-run')) return jsonResponse({ run: null })
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)

    expect(await screen.findByText('已确定')).toBeInTheDocument()
    expect(screen.getByText('用户端、购物车、下单和支付')).toBeInTheDocument()
    expect(screen.getByText('please use admin for this area')).toBeInTheDocument()
    expect(screen.queryByText('Confirmed')).not.toBeInTheDocument()
    expect(screen.queryByText('user_app、TRANSACTION')).not.toBeInTheDocument()
  })

  it('does not restore an already answered historical clarification card after refresh', async () => {
    const blockedDraft: ProductMessage = {
      ...priorMessage,
      id: 'MSG-ANSWERED-DRAFT',
      role: 'ASSISTANT',
      content: '方案草稿',
      skillId: 'SOLUTION_DRAFT',
      solutionDraft: {
        id: 'DRAFT-ANSWERED',
        conversationId: conversationA.id,
        sourceRunId: 'RUN-ANSWERED',
        currentVersion: 1,
        status: 'BLOCKED',
        title: '商城方案',
        customerContext: '商城方案',
        executiveSummary: '初步方案',
        requirements: [],
        sections: [],
        assumptions: [],
        openQuestions: [],
        risks: [],
        conflicts: [],
        evidenceGaps: [],
        citations: [],
        quality: { status: 'BLOCKED', evidenceCoverage: 0, missingSections: [], invalidCitations: [], notes: [] },
        clarificationQuestions: [{
          id: 'CUSTOMER',
          question: '客户主体和商城运营主体是否已经确定？',
          type: 'SINGLE_CHOICE',
          options: [{ id: 'confirmed', label: '已确定' }],
          required: true,
          allowSkip: true,
          position: 1,
          total: 1,
        }],
        clarificationQuestionsResolved: false,
        createdAt: conversationA.createdAt,
        updatedAt: conversationA.updatedAt,
      },
    }
    const answeredMessage: ProductMessage = {
      ...priorMessage,
      id: 'MSG-ANSWERED-USER',
      role: 'USER',
      content: 'confirmed',
      answerStatus: null,
    }
    const continued: ProductMessage = {
      ...priorMessage,
      id: 'MSG-ANSWERED-CONTINUATION',
      role: 'ASSISTANT',
      content: '正式方案已生成。',
      answerStatus: 'SUPPORTED',
    }
    mockFetch((path, init) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA] })
      if (path === '/api/chat/conversations/CVS-A' && !init?.method) return jsonResponse(detail(conversationA, [blockedDraft, answeredMessage, continued]))
      if (path.endsWith('/active-run')) return jsonResponse({ run: null })
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)

    expect(await screen.findByText('正式方案已生成。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '已确定' })).not.toBeInTheDocument()
    expect(screen.queryByText('待确认问题')).not.toBeInTheDocument()
  })

  it('accumulates clarification answers across historical blocked batches after refresh', async () => {
    const questions: NonNullable<ProductMessage['solutionDraft']>['clarificationQuestions'] = [
      {
        id: 'CUSTOMER',
        question: '客户主体是否确定？',
        type: 'SINGLE_CHOICE',
        options: [{ id: 'confirmed', label: '已确定' }],
        required: true,
        allowSkip: true,
        position: 1,
        total: 3,
      },
      {
        id: 'DEPLOYMENT',
        question: '采用哪种部署方式？',
        type: 'SINGLE_CHOICE',
        options: [{ id: 'private', label: '私有化部署' }],
        required: true,
        allowSkip: true,
        position: 2,
        total: 3,
      },
      {
        id: 'BUDGET',
        question: '预算范围是多少？',
        type: 'SINGLE_CHOICE',
        options: [{ id: 'range_a', label: '100–300 万元' }],
        required: true,
        allowSkip: true,
        position: 3,
        total: 3,
      },
    ]
    const blockedDraft = (
      id: string,
      sourceRunId: string,
      clarificationQuestions: NonNullable<ProductMessage['solutionDraft']>['clarificationQuestions'],
    ): ProductMessage => ({
      ...priorMessage,
      id,
      role: 'ASSISTANT',
      content: '方案草稿',
      skillId: 'SOLUTION_DRAFT',
      solutionDraft: {
        id: `DRAFT-${id}`,
        conversationId: conversationA.id,
        sourceRunId,
        currentVersion: 1,
        status: 'BLOCKED',
        title: '商城方案',
        customerContext: '商城方案',
        executiveSummary: '初步方案',
        requirements: [],
        sections: [],
        assumptions: [],
        openQuestions: [],
        risks: [],
        conflicts: [],
        evidenceGaps: [],
        citations: [],
        quality: { status: 'BLOCKED', evidenceCoverage: 0, missingSections: [], invalidCitations: [], notes: [] },
        clarificationQuestions,
        clarificationQuestionsResolved: false,
        createdAt: conversationA.createdAt,
        updatedAt: conversationA.updatedAt,
      },
    })
    const messages: ProductMessage[] = [
      blockedDraft('MSG-BATCH-ONE', 'RUN-BATCH-ONE', questions),
      {
        ...priorMessage,
        id: 'MSG-BATCH-ONE-ANSWER',
        role: 'USER',
        content: JSON.stringify({ CUSTOMER: 'confirmed', DEPLOYMENT: 'private' }),
        answerStatus: null,
      },
      blockedDraft('MSG-BATCH-TWO', 'RUN-BATCH-TWO', [questions[2]]),
      {
        ...priorMessage,
        id: 'MSG-BATCH-TWO-ANSWER',
        role: 'USER',
        content: JSON.stringify({ BUDGET: 'range_a' }),
        answerStatus: null,
      },
      {
        ...priorMessage,
        id: 'MSG-BATCH-COMPLETE',
        role: 'ASSISTANT',
        content: '全部条件已确认，正式方案已生成。',
      },
    ]
    mockFetch((path, init) => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA] })
      if (path === '/api/chat/conversations/CVS-A' && !init?.method) return jsonResponse(detail(conversationA, messages))
      if (path.endsWith('/active-run')) return jsonResponse({ run: null })
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)

    expect(await screen.findByText('全部条件已确认，正式方案已生成。')).toBeInTheDocument()
    const userReplies = [...document.querySelectorAll<HTMLElement>('.message-user p')]
      .map((element) => element.textContent)
    expect(userReplies).toContain('客户主体是否确定？：已确定\n采用哪种部署方式？：私有化部署')
    expect(userReplies).toContain('预算范围是多少？：100–300 万元')
    expect(screen.queryByLabelText('待确认问题')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '已确定' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '私有化部署' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '100–300 万元' })).not.toBeInTheDocument()
  })

  it('applies the final answer immediately after production progress completes', async () => {
    const user = userEvent.setup()
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
    expect(screen.getByRole('combobox', { name: '回答方式' })).toBeDisabled()
    expect(textbox).toHaveValue('')
    expect(document.querySelector('.message-pending-question')).toHaveTextContent('发送期间保留')
    expect(screen.getByRole('status', { name: '执行过程' })).toBeInTheDocument()
    // Until the first backend progress event arrives, the compact indicator
    // only says it is preparing; no fictitious execution step is shown.
    expect(screen.queryByRole('button', { name: '查看执行过程' })).not.toBeInTheDocument()

    await act(async () => {
      resolveSend(sseResponse({
        conversation: conversationA,
        userMessage: { ...priorMessage, id: 'MSG-U', role: 'USER', content: '发送期间保留', answerStatus: null },
        assistantMessage: { ...priorMessage, id: 'MSG-A', content: '已回答' },
      }))
      await pendingSend
    })
    expect(screen.queryByRole('status', { name: '执行过程' })).not.toBeInTheDocument()
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
    expect(screen.queryByRole('status', { name: '执行过程' })).not.toBeInTheDocument()

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
    const archivedDrawer = screen.getByRole('region', { name: '已归档会话抽屉' })
    expect(archivedDrawer).toHaveAttribute('aria-hidden', 'false')
    expect(archivedDrawer).toHaveTextContent('仅供查看，可恢复')
    expect(screen.getByRole('button', { name: '项目 A' })).toBeInTheDocument()
    expect(within(archivedDrawer).getByRole('button', { name: '已归档项目' })).toBeInTheDocument()

    await user.click(within(archivedDrawer).getByRole('button', { name: '收起已归档会话' }))
    expect(archivedDrawer).toHaveAttribute('aria-hidden', 'true')
    await user.click(screen.getByRole('button', { name: '展开已归档会话' }))
    expect(archivedDrawer).toHaveAttribute('aria-hidden', 'false')

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

  it('keeps archive and background tasks mutually exclusive and hides the archive entry while open', async () => {
    const user = userEvent.setup()
    const archives = Array.from({ length: 80 }, (_, index) => ({
      ...conversationA, id: `ARCHIVE-${index}`, title: `归档会话 ${index + 1}`, status: 'ARCHIVED' as const,
    }))
    mockFetch(path => {
      if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA, ...archives] })
      if (path === '/api/chat/conversations/CVS-A') return jsonResponse(detail(conversationA))
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<ChatPage />)
    await screen.findByText('原有回答')
    const archiveTrigger = screen.getByRole('button', { name: '展开已归档会话' })
    const activityTrigger = screen.getByRole('button', { name: '后台任务' })
    await user.click(activityTrigger)
    expect(activityTrigger).toHaveAttribute('aria-expanded', 'true')
    await user.click(archiveTrigger)
    expect(activityTrigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByLabelText('后台会议任务')).not.toBeInTheDocument()
    let drawer = screen.getByRole('region', { name: '已归档会话抽屉' })
    expect(within(drawer).getAllByRole('button')).toHaveLength(81)
    expect(within(drawer).getByRole('button', { name: '归档会话 80' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '项目 A' })).toBeInTheDocument()
    await user.click(activityTrigger)
    expect(screen.queryByRole('region', { name: '已归档会话抽屉' })).not.toBeInTheDocument()
    expect(activityTrigger).toHaveAttribute('aria-expanded', 'true')
    expect(archiveTrigger).toBeVisible()
    await user.click(archiveTrigger)
    expect(archiveTrigger).not.toBeVisible()
    drawer = screen.getByRole('region', { name: '已归档会话抽屉' })
    await user.click(within(drawer).getByRole('button', { name: '收起已归档会话' }))
    expect(archiveTrigger).toBeVisible()
    expect(archiveTrigger).toHaveFocus()
    await user.click(archiveTrigger)
    await user.keyboard('{Escape}')
    expect(archiveTrigger).toHaveAttribute('aria-expanded', 'false')
    expect(archiveTrigger).toBeVisible()
    expect(archiveTrigger).toHaveFocus()
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
    expect(appCss).toMatch(/\.chat-main\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\) auto/s)
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
    await screen.findByRole('heading', { level: 2, name: '让每一次工作协作，都从一个对话开始。' })
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


it('allows switching and a new conversation during a durable meeting without cancelling it or mixing late results', async () => {
  const user = userEvent.setup()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let signal: AbortSignal | undefined
  const fetcher = mockFetch((path, init) => {
    if (path === '/api/chat/meeting-activity') return jsonResponse({ tasks: [] })
    if (path.endsWith('/active-run')) return jsonResponse({ run: null })
    if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA, conversationB] })
    if (path === '/api/chat/conversations/CVS-A') return jsonResponse(detail(conversationA))
    if (path === '/api/chat/conversations/CVS-B') return jsonResponse(detail(conversationB, []))
    if (path === '/api/chat/conversations/CVS-A/messages/stream') {
      signal = init?.signal as AbortSignal
      return new Response(new ReadableStream<Uint8Array>({ start(c) {
        controller = c
        c.enqueue(new TextEncoder().encode('event: run_started\ndata: {"runId":"MT-background","skillId":"MEETING_ANALYSIS"}\n\n'))
      } }), { headers: { 'content-type': 'text/event-stream' } })
    }
    throw new Error(`Unexpected request: ${path}`)
  })
  render(<ChatPage />)
  await screen.findByText('原有回答')
  await user.type(screen.getByRole('textbox', { name: '问题' }), '@会议纪要 整理本次讨论')
  await user.click(screen.getByRole('button', { name: '发送问题' }))
  await screen.findByText(/会议正在后台处理/)
  expect(screen.getByRole('button', { name: '新对话' })).toBeEnabled()
  expect(screen.getByRole('button', { name: '项目 B' })).toBeEnabled()
  expect(screen.getByRole('textbox', { name: '问题' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: '项目 B' }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: '问题' })).toBeEnabled())
  expect(signal?.aborted).toBe(true)
  expect(fetcher.mock.calls.some(([path]) => String(path).includes('/cancel'))).toBe(false)
  // Switching releases the stream reader; late server events cannot enter the new conversation.
  expect(() => controller.enqueue(new TextEncoder().encode('late event'))).toThrow()
  expect(screen.queryByText('整理本次讨论')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '新对话' }))
  expect(screen.getByRole('textbox', { name: '问题' })).toBeEnabled()
})

it('opens background task entries without restarting the current stream and targets the selected meeting', async () => {
  const user = userEvent.setup()
  const encoder = new TextEncoder()
  const streams: Array<{ signal: AbortSignal; controller: ReadableStreamDefaultController<Uint8Array> }> = []
  const tasks = [
    { id: 'MT-current', conversationId: 'CVS-A', title: '正在核对的会议', state: 'running', progress: { message: '核对原文：第 3/7 部分' }, updatedAt: '2026-09-19T14:00:00Z' },
    { id: 'MT-old', conversationId: 'CVS-A', title: '此前取消的会议', state: 'cancelled', progress: { message: '已取消' }, updatedAt: '2026-09-19T13:00:00Z' },
  ]
  const oldMessage: ProductMessage = { ...priorMessage, meeting: {
    id: 'MT-old', conversationId: 'CVS-A', state: 'cancelled', version: 0,
    progress: { message: '已取消' }, updatedAt: tasks[1].updatedAt, sources: [],
  } }
  const fetcher = mockFetch((path, init) => {
    if (path === '/api/chat/meeting-activity') return jsonResponse({ tasks })
    if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA, conversationB] })
    if (path === '/api/chat/conversations/CVS-A') return jsonResponse(detail(conversationA, [oldMessage]))
    if (path === '/api/chat/conversations/CVS-B') return jsonResponse(detail(conversationB, []))
    if (path === '/api/chat/conversations/CVS-B/active-run') return jsonResponse({ run: null })
    if (path === '/api/chat/conversations/CVS-A/active-run') return jsonResponse({ run: {
      runId: 'MT-current', status: 'running', skillId: 'MEETING_ANALYSIS', inputContent: '@会议纪要 当前会议',
    } })
    if (path === '/api/chat/runs/MT-current/events?afterSeq=0') return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      streams.push({ signal: init?.signal as AbortSignal, controller })
      controller.enqueue(encoder.encode('event: progress\ndata: {"stage":"VERIFYING","message":"核对原文：第 3/7 部分","runId":"MT-current"}\n\n'))
    } }), { headers: { 'content-type': 'text/event-stream' } })
    throw new Error(`Unexpected request: ${path}`)
  })
  const view = render(<ChatPage />)
  await screen.findByText(/会议正在后台处理/)
  const live = document.querySelector<HTMLElement>('[data-meeting-id="MT-current"]')!
  const old = document.querySelector<HTMLElement>('[data-meeting-id="MT-old"]')!
  live.scrollIntoView = vi.fn()
  old.scrollIntoView = vi.fn()
  const requestsBeforeOpen = fetcher.mock.calls.length
  for (const title of ['正在核对的会议', '此前取消的会议']) {
    await user.click(screen.getByRole('button', { name: /后台任务/ }))
    await user.click(within(screen.getByLabelText('后台会议任务')).getByRole('button', { name: new RegExp(title) }))
    await waitFor(() => expect(screen.queryByLabelText('后台会议任务')).not.toBeInTheDocument())
  }
  expect(live.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
  expect(old.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
  expect(fetcher.mock.calls).toHaveLength(requestsBeforeOpen)
  expect(streams).toHaveLength(1)
  expect(streams[0].signal.aborted).toBe(false)
  expect(document.querySelector('[data-meeting-id="MT-current"]')).toBe(live)
  await act(async () => streams[0].controller.enqueue(encoder.encode('event: progress\ndata: {"stage":"VERIFYING","message":"核对原文：第 4/7 部分","runId":"MT-current"}\n\n')))
  expect(screen.getAllByText('核对原文：第 4/7 部分').length).toBeGreaterThan(0)
  await user.click(screen.getByRole('button', { name: /项目 A/ }))
  expect(streams[0].signal.aborted).toBe(false)
  // Switching away and back only reconnects to the existing run through GET.
  await user.click(screen.getByRole('button', { name: '项目 B' }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: '问题' })).toBeEnabled())
  expect(streams[0].signal.aborted).toBe(true)
  await user.click(screen.getByRole('button', { name: /项目 A/ }))
  await waitFor(() => expect(streams).toHaveLength(2))
  expect(document.querySelector('.chat-main')).toHaveAttribute('data-agent-run-id', 'MT-current')
  expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true)
  expect(fetcher.mock.calls.some(([path]) => /\/(retry|cancel|resume)(\?|$)/.test(String(path)))).toBe(false)
  view.unmount()
})

it('restores the running indicator on the matching background conversation and keeps it after switching', async () => {
  const user = userEvent.setup()
  mockFetch((path) => {
    if (path === '/api/chat/meeting-activity') return jsonResponse({ tasks: [{
      id: 'MT-other', conversationId: 'CVS-B', title: '后台会议', state: 'running',
      progress: { message: '提炼纪要' }, updatedAt: '2026-09-18T07:00:00Z',
    }] })
    if (path.endsWith('/active-run')) return jsonResponse({ run: null })
    if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA, conversationB] })
    if (path === '/api/chat/conversations/CVS-A') return jsonResponse(detail(conversationA))
    if (path === '/api/chat/conversations/CVS-B') return jsonResponse(detail(conversationB, []))
    throw new Error(`Unexpected request: ${path}`)
  })
  render(<ChatPage />)
  await screen.findByText('原有回答')
  const running = await screen.findByRole('status', { name: '正在运行' })
  const row = screen.getByRole('button', { name: /项目 B/ })
  expect(row).toContainElement(running)
  expect(screen.getAllByRole('status', { name: '正在运行' })).toHaveLength(1)
  await user.click(row)
  await waitFor(() => expect(row).toHaveAttribute('aria-current', 'page'))
  expect(within(row).getByRole('status', { name: '正在运行' })).toBeInTheDocument()
})

it('clears rejected previews before retry and shows validation failure instead of insufficient knowledge', async () => {
  const user = userEvent.setup()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const encoder = new TextEncoder()
  mockFetch((path, init) => {
    if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA] })
    if (path === '/api/chat/conversations/CVS-A' && !init?.method) return jsonResponse(detail(conversationA))
    if (path.endsWith('/messages/stream')) return new Response(new ReadableStream<Uint8Array>({
      start(c) { controller = c },
    }), { headers: { 'content-type': 'text/event-stream' } })
    if (path.endsWith('/active-run')) return jsonResponse({ run: null })
    if (path === '/api/chat/meeting-activity') return jsonResponse({ tasks: [] })
    throw new Error(`Unexpected request: ${path}`)
  })
  render(<ChatPage />)
  await screen.findByText('原有回答')
  await user.type(screen.getByRole('textbox', { name: '问题' }), '系统架构图')
  await user.click(screen.getByRole('button', { name: '发送问题' }))
  await act(async () => controller.enqueue(encoder.encode('event: delta\ndata: {"content":"未核验旧预览"}\n\n')))
  expect(await screen.findByText('未核验旧预览')).toBeInTheDocument()
  await act(async () => controller.enqueue(encoder.encode('event: progress\ndata: {"stage":"COMPOSING","message":"正在重新生成","resetAnswer":true}\n\nevent: delta\ndata: {"content":"重新生成预览"}\n\n')))
  expect(await screen.findByText('重新生成预览')).toBeInTheDocument()
  expect(screen.queryByText('未核验旧预览')).not.toBeInTheDocument()
  await act(async () => {
    controller.enqueue(encoder.encode('event: progress\ndata: {"stage":"COMPOSING","message":"引用校验失败","resetAnswer":true}\n\nevent: error\ndata: {"code":"ANSWER_CITATION_INVALID","message":"回答引用校验未通过，请重试。"}\n\n'))
    controller.close()
  })
  expect(await screen.findByRole('alert')).toHaveTextContent('回答引用校验未通过')
  expect(screen.queryByText('重新生成预览')).not.toBeInTheDocument()
  expect(screen.queryByText('暂无足够可靠资料')).not.toBeInTheDocument()
})


it('exits the selected meeting revision without losing user requirements or changing the saved minutes', async () => {
  const user = userEvent.setup()
  const meetingMessage: ProductMessage = { ...priorMessage, meeting: {
    id: 'MT-edit', conversationId: 'CVS-A', state: 'completed', version: 1,
    progress: { message: '完成' }, updatedAt: '2026-09-20T01:00:00Z', sources: [],
    result: { title: '项目复盘会议', meetingType: '内部管理', body: '已保存的纪要正文' },
  } }
  const fetcher = mockFetch(path => {
    if (path === '/api/chat/conversations') return jsonResponse({ conversations: [conversationA] })
    if (path === '/api/chat/conversations/CVS-A') return jsonResponse(detail(conversationA, [meetingMessage]))
    if (path.endsWith('/active-run')) return jsonResponse({ run: null })
    if (path === '/api/chat/meeting-activity') return jsonResponse({ tasks: [] })
    if (path.startsWith('/api/chat/meetings')) return jsonResponse({ meetings: [], items: [], total: 0 })
    throw new Error(`Unexpected request: ${path}`)
  })
  render(<ChatPage />)
  await user.click(await screen.findByRole('button', { name: 'AI 帮我修改' }))
  expect(screen.getByRole('region', { name: 'AI 修改纪要' })).toHaveTextContent('项目复盘会议')
  await user.click(screen.getByRole('button', { name: '退出修改' }))
  expect(screen.getByRole('textbox', { name: '问题' })).toHaveValue('')
  await user.click(screen.getByRole('button', { name: 'AI 帮我修改' }))
  await user.type(screen.getByRole('textbox', { name: '问题' }), '保留关键决定')
  await user.click(screen.getByRole('button', { name: '退出修改' }))
  expect(screen.getByRole('textbox', { name: '问题' })).toHaveValue('保留关键决定')
  expect(screen.queryByRole('region', { name: 'AI 修改纪要' })).not.toBeInTheDocument()
  expect(screen.getByText('已保存的纪要正文')).toBeInTheDocument()
  expect(fetcher.mock.calls.filter(([, init]) => init?.method && init.method !== 'GET')).toHaveLength(0)
})
