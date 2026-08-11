import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ChatPage } from './ChatPage'

vi.mock('../session/SessionProvider', () => ({
  useSession: () => ({
    user: { id: 'USR-EMPLOYEE', name: '演示员工', role: 'EMPLOYEE' },
    users: [
      { id: 'USR-EMPLOYEE', name: '演示员工', role: 'EMPLOYEE' },
      { id: 'USR-OWNER', name: '知识负责人', role: 'OWNER' },
    ],
  }),
}))

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function renderPage() {
  return render(<MemoryRouter><ChatPage /></MemoryRouter>)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ChatPage', () => {
  it('shows a centered composer when there is no conversation history', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ conversations: [] })))

    renderPage()

    expect(await screen.findByRole('heading', { name: '知识问答' })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('输入你的问题')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '发送' })).toBeInTheDocument()
    expect(screen.getByLabelText('回答范围')).toHaveValue('ENTERPRISE')
    expect(screen.queryByLabelText('会话历史')).not.toBeInTheDocument()
    expect(screen.queryByText('从一个问题开始')).not.toBeInTheDocument()
  })

  it('creates a conversation, keeps message order, and opens a citation source drawer', async () => {
    const conversation = {
      id: 'CVS-1', title: '部署问题', userId: 'USR-EMPLOYEE', scope: 'ENTERPRISE',
      sessionAssetIds: [], status: 'ACTIVE', messageCount: 2, negativeFeedbackCount: 0,
      hasOpenIssue: false, createdAt: '2026-08-11T12:00:00.000Z', lastActiveAt: '2026-08-11T12:00:00.000Z',
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ conversations: [] }))
      .mockResolvedValueOnce(json({ conversation }))
      .mockResolvedValueOnce(json({
        conversation: { ...conversation, messageCount: 2 },
        message: {
          id: 'MSG-A', conversationId: conversation.id, role: 'ASSISTANT',
          text: '标准部署最低需要 4 张 A800。',
          citations: [{ knowledgeId: 'KNW-1', title: '标准部署要求', assetId: 'AST-1', locator: 'paragraph:1', excerpt: '标准部署最低需要 4 张 A800。' }],
          createdAt: '2026-08-11T12:00:01.000Z',
        },
        answer: { text: '标准部署最低需要 4 张 A800。', confidence: 'SUPPORTED', citations: [{ knowledgeId: 'KNW-1', title: '标准部署要求', assetId: 'AST-1', locator: 'paragraph:1', excerpt: '标准部署最低需要 4 张 A800。' }] },
      }))
      .mockResolvedValueOnce(json({
        conversation: { ...conversation, messageCount: 4 },
        message: { id: 'MSG-A2', conversationId: conversation.id, role: 'ASSISTANT', text: '这是第二个回答。', citations: [], createdAt: '2026-08-11T12:00:03.000Z' },
        answer: { text: '这是第二个回答。', confidence: 'SUPPORTED', citations: [] },
      }))
    vi.stubGlobal('fetch', fetchMock)

    renderPage()
    const input = await screen.findByPlaceholderText('输入你的问题')
    await userEvent.type(input, '部署需要多少张卡？')
    await userEvent.click(screen.getByRole('button', { name: '发送' }))

    expect(await screen.findByText('部署需要多少张卡？')).toBeInTheDocument()
    expect(screen.getByText('标准部署最低需要 4 张 A800。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '[1]' })).toBeInTheDocument()

    await userEvent.type(screen.getByPlaceholderText('输入你的问题'), '继续说明第二点')
    await userEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(await screen.findByText('这是第二个回答。')).toBeInTheDocument()
    const threadText = screen.getByLabelText('消息线程').textContent ?? ''
    expect(threadText.indexOf('部署需要多少张卡？')).toBeLessThan(threadText.indexOf('标准部署最低需要 4 张 A800。'))
    expect(threadText.indexOf('标准部署最低需要 4 张 A800。')).toBeLessThan(threadText.indexOf('继续说明第二点'))
    expect(threadText.indexOf('继续说明第二点')).toBeLessThan(threadText.indexOf('这是第二个回答。'))

    await userEvent.click(screen.getByRole('button', { name: '[1]' }))
    expect(await screen.findByRole('dialog', { name: '来源详情' })).toBeInTheDocument()
    expect(screen.getByText('标准部署要求')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '查看资料' })).not.toBeInTheDocument()
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/conversations', expect.objectContaining({ method: 'POST' }))
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/conversations/CVS-1/messages', expect.objectContaining({ method: 'POST' }))
  })

  it('loads an existing conversation on refresh', async () => {
    const conversation = {
      id: 'CVS-2', title: '历史问题', userId: 'USR-EMPLOYEE', scope: 'BOTH', sessionAssetIds: [], status: 'ACTIVE',
      messageCount: 2, negativeFeedbackCount: 0, hasOpenIssue: false,
      createdAt: '2026-08-11T12:00:00.000Z', lastActiveAt: '2026-08-11T12:00:00.000Z',
    }
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ conversations: [conversation] }))
      .mockResolvedValueOnce(json({ conversation, messages: [
        { id: 'MSG-U', conversationId: 'CVS-2', role: 'USER', text: '历史问题', citations: [], createdAt: '2026-08-11T12:00:00.000Z' },
        { id: 'MSG-A', conversationId: 'CVS-2', role: 'ASSISTANT', text: '历史回答', citations: [], createdAt: '2026-08-11T12:00:01.000Z' },
      ] })))

    renderPage()

    expect(await screen.findByText('历史回答')).toBeInTheDocument()
    expect(screen.getAllByText('历史问题').length).toBeGreaterThanOrEqual(2)
  })

  it('locks conversation navigation while a message is pending', async () => {
    const conversation = {
      id: 'CVS-PENDING', title: '处理中会话', userId: 'USR-EMPLOYEE', scope: 'ENTERPRISE', sessionAssetIds: [], status: 'ACTIVE',
      messageCount: 2, negativeFeedbackCount: 0, hasOpenIssue: false,
      createdAt: '2026-08-11T12:00:00.000Z', lastActiveAt: '2026-08-11T12:00:00.000Z',
    }
    const pendingResponse = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ conversations: [conversation] }))
      .mockResolvedValueOnce(json({ conversation, messages: [
        { id: 'MSG-U', conversationId: conversation.id, role: 'USER', text: '原问题', citations: [], createdAt: '2026-08-11T12:00:00.000Z' },
        { id: 'MSG-A', conversationId: conversation.id, role: 'ASSISTANT', text: '原回答', citations: [], createdAt: '2026-08-11T12:00:01.000Z' },
      ], sessionAssets: [] }))
      .mockImplementationOnce(() => pendingResponse.promise))

    renderPage()
    await userEvent.type(await screen.findByPlaceholderText('输入你的问题'), '等待回答')
    await userEvent.click(screen.getByRole('button', { name: '发送' }))

    expect(await screen.findByText('等待回答')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '新对话' }).every((button) => button.hasAttribute('disabled'))).toBe(true)
    expect(screen.getByRole('button', { name: '处理中会话' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '归档会话' })).toBeDisabled()

    pendingResponse.resolve(json({
      conversation: { ...conversation, messageCount: 4 },
      message: { id: 'MSG-A2', conversationId: conversation.id, role: 'ASSISTANT', text: '处理完成', citations: [], createdAt: '2026-08-11T12:00:03.000Z' },
      answer: { text: '处理完成', confidence: 'SUPPORTED', citations: [] },
    }))
    expect(await screen.findByText('处理完成')).toBeInTheDocument()
  })

  it('locks conversation navigation while an attachment is processing', async () => {
    const conversation = {
      id: 'CVS-UPLOAD', title: '上传会话', userId: 'USR-EMPLOYEE', scope: 'BOTH', sessionAssetIds: [], status: 'ACTIVE',
      messageCount: 0, negativeFeedbackCount: 0, hasOpenIssue: false,
      createdAt: '2026-08-11T12:00:00.000Z', lastActiveAt: '2026-08-11T12:00:00.000Z',
    }
    const sessionAsset = {
      id: 'AST-PENDING', title: '处理中.txt', assetType: 'DOCUMENT', businessType: 'SESSION_UPLOAD', provider: 'LOCAL',
      externalId: 'local:AST-PENDING', ownerId: 'USR-EMPLOYEE', authority: 'L0', processStatus: 'NEW',
      createdAt: '2026-08-11T12:00:00.000Z', updatedAt: '2026-08-11T12:00:00.000Z', isSessionAsset: true, sections: [],
    }
    const pendingProcess = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ conversations: [conversation] }))
      .mockResolvedValueOnce(json({ conversation, messages: [], sessionAssets: [] }))
      .mockResolvedValueOnce(json({ asset: sessionAsset }, 201))
      .mockImplementationOnce(() => pendingProcess.promise))

    renderPage()
    await userEvent.upload(await screen.findByLabelText('上传文本资料'), new File(['内容'], '处理中.txt', { type: 'text/plain' }))

    expect(await screen.findByText('处理中')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '新对话' }).every((button) => button.hasAttribute('disabled'))).toBe(true)
    expect(screen.getByRole('button', { name: '上传会话' })).toBeDisabled()

    pendingProcess.resolve(json({ asset: { ...sessionAsset, processStatus: 'PROCESSED' } }))
    expect(await screen.findByText('已就绪')).toBeInTheDocument()
  })

  it('marks an expired Session Asset unavailable and excludes it from the next message', async () => {
    const conversation = {
      id: 'CVS-EXPIRED', title: '过期附件', userId: 'USR-EMPLOYEE', scope: 'SESSION', sessionAssetIds: ['AST-EXPIRED'], status: 'ACTIVE',
      messageCount: 0, negativeFeedbackCount: 0, hasOpenIssue: false,
      createdAt: '2026-08-11T12:00:00.000Z', lastActiveAt: '2026-08-11T12:00:00.000Z',
    }
    const expiredAsset = {
      id: 'AST-EXPIRED', title: '已过期资料.txt', assetType: 'DOCUMENT', businessType: 'SESSION_UPLOAD', provider: 'LOCAL',
      externalId: 'local:AST-EXPIRED', ownerId: 'USR-EMPLOYEE', authority: 'L0', processStatus: 'PROCESSED',
      createdAt: '2026-08-10T12:00:00.000Z', updatedAt: '2026-08-10T12:00:00.000Z', isSessionAsset: true,
      expiresAt: '2026-08-11T00:00:00.000Z', sections: [],
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ conversations: [conversation] }))
      .mockResolvedValueOnce(json({ conversation, messages: [], sessionAssets: [expiredAsset] }))
      .mockResolvedValueOnce(json({
        conversation: { ...conversation, sessionAssetIds: [], messageCount: 2 },
        message: { id: 'MSG-A', conversationId: conversation.id, role: 'ASSISTANT', text: '资料已过期。', citations: [], createdAt: '2026-08-11T12:00:01.000Z' },
        answer: { text: '资料已过期。', confidence: 'INSUFFICIENT', citations: [] },
      }))
    vi.stubGlobal('fetch', fetchMock)

    renderPage()
    expect(await screen.findByText('已过期')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '提交 已过期资料.txt 为企业资料' })).not.toBeInTheDocument()
    await userEvent.type(screen.getByPlaceholderText('输入你的问题'), '还能使用吗？')
    await userEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(await screen.findByText('资料已过期。')).toBeInTheDocument()

    const request = fetchMock.mock.calls[2][1] as RequestInit
    expect(JSON.parse(String(request.body)).sessionAssetIds).toEqual([])
  })

  it('restores every Session Asset when an existing conversation is loaded', async () => {
    const conversation = {
      id: 'CVS-ASSETS', title: '带附件的会话', userId: 'USR-EMPLOYEE', scope: 'BOTH', sessionAssetIds: ['AST-A', 'AST-B'], status: 'ACTIVE',
      messageCount: 0, negativeFeedbackCount: 0, hasOpenIssue: false,
      createdAt: '2026-08-11T12:00:00.000Z', lastActiveAt: '2026-08-11T12:00:00.000Z',
    }
    const sessionAssets = [
      {
        id: 'AST-A', title: '部署说明 A.txt', assetType: 'DOCUMENT', businessType: 'SESSION_UPLOAD', provider: 'LOCAL',
        externalId: 'local:AST-A', ownerId: 'USR-EMPLOYEE', authority: 'L0', processStatus: 'PROCESSED',
        createdAt: '2026-08-11T12:00:00.000Z', updatedAt: '2026-08-11T12:00:00.000Z', isSessionAsset: true, sections: [],
      },
      {
        id: 'AST-B', title: '部署说明 B.md', assetType: 'DOCUMENT', businessType: 'SESSION_UPLOAD', provider: 'LOCAL',
        externalId: 'local:AST-B', ownerId: 'USR-EMPLOYEE', authority: 'L0', processStatus: 'PROCESSED',
        createdAt: '2026-08-11T12:00:00.000Z', updatedAt: '2026-08-11T12:00:00.000Z', isSessionAsset: true, sections: [],
      },
    ]
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ conversations: [conversation] }))
      .mockResolvedValueOnce(json({ conversation, messages: [], sessionAssets })))

    renderPage()

    expect(await screen.findAllByText('部署说明 A.txt')).not.toHaveLength(0)
    expect(screen.getAllByText('部署说明 B.md')).not.toHaveLength(0)
  })

  it('keeps multiple uploads and sends every ready Session Asset id', async () => {
    const makeAsset = (id: string, title: string) => ({
      id, title, assetType: 'DOCUMENT', businessType: 'SESSION_UPLOAD', provider: 'LOCAL',
      externalId: `local:${id}`, ownerId: 'USR-EMPLOYEE', authority: 'L0', processStatus: 'NEW',
      createdAt: '2026-08-11T12:00:00.000Z', updatedAt: '2026-08-11T12:00:00.000Z', isSessionAsset: true, sections: [],
    })
    const firstAsset = makeAsset('AST-FIRST', '第一份.txt')
    const secondAsset = makeAsset('AST-SECOND', '第二份.md')
    const conversation = {
      id: 'CVS-MULTI', title: '多附件问题', userId: 'USR-EMPLOYEE', scope: 'BOTH', sessionAssetIds: ['AST-FIRST', 'AST-SECOND'], status: 'ACTIVE',
      messageCount: 0, negativeFeedbackCount: 0, hasOpenIssue: false,
      createdAt: '2026-08-11T12:00:00.000Z', lastActiveAt: '2026-08-11T12:00:00.000Z',
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ conversations: [] }))
      .mockResolvedValueOnce(json({ asset: firstAsset }, 201))
      .mockResolvedValueOnce(json({ asset: { ...firstAsset, processStatus: 'PROCESSED' } }))
      .mockResolvedValueOnce(json({ asset: secondAsset }, 201))
      .mockResolvedValueOnce(json({ asset: { ...secondAsset, processStatus: 'PROCESSED' } }))
      .mockResolvedValueOnce(json({ conversation }))
      .mockResolvedValueOnce(json({
        conversation: { ...conversation, messageCount: 2 },
        message: { id: 'MSG-A', conversationId: conversation.id, role: 'ASSISTANT', text: '已综合两份资料。', citations: [], createdAt: '2026-08-11T12:00:01.000Z' },
        answer: { text: '已综合两份资料。', confidence: 'SUPPORTED', citations: [] },
      }))
    vi.stubGlobal('fetch', fetchMock)

    renderPage()
    const input = await screen.findByLabelText('上传文本资料')
    await userEvent.upload(input, new File(['第一份'], '第一份.txt', { type: 'text/plain' }))
    expect(await screen.findAllByText('第一份.txt')).not.toHaveLength(0)
    await userEvent.upload(input, new File(['第二份'], '第二份.md', { type: 'text/markdown' }))
    expect(await screen.findAllByText('第二份.md')).not.toHaveLength(0)
    expect(screen.getAllByText('第一份.txt')).not.toHaveLength(0)

    await userEvent.selectOptions(screen.getByLabelText('回答范围'), 'BOTH')
    await userEvent.type(screen.getByPlaceholderText('输入你的问题'), '综合附件')
    await userEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(await screen.findByText('已综合两份资料。')).toBeInTheDocument()

    const createRequest = fetchMock.mock.calls.find(([url, options]) => url === '/api/conversations' && (options as RequestInit | undefined)?.method === 'POST')?.[1] as RequestInit
    const messageRequest = fetchMock.mock.calls.find(([url]) => url === '/api/conversations/CVS-MULTI/messages')?.[1] as RequestInit
    expect(JSON.parse(String(createRequest.body)).sessionAssetIds).toEqual(['AST-FIRST', 'AST-SECOND'])
    expect(JSON.parse(String(messageRequest.body)).sessionAssetIds).toEqual(['AST-FIRST', 'AST-SECOND'])
  })

  it('removes only the Session Asset that was promoted', async () => {
    const conversation = {
      id: 'CVS-PROMOTE', title: '附件提升', userId: 'USR-EMPLOYEE', scope: 'BOTH', sessionAssetIds: ['AST-A', 'AST-B'], status: 'ACTIVE',
      messageCount: 0, negativeFeedbackCount: 0, hasOpenIssue: false,
      createdAt: '2026-08-11T12:00:00.000Z', lastActiveAt: '2026-08-11T12:00:00.000Z',
    }
    const sessionAssets = ['A', 'B'].map((suffix) => ({
      id: `AST-${suffix}`, title: `会话资料 ${suffix}.txt`, assetType: 'DOCUMENT', businessType: 'SESSION_UPLOAD', provider: 'LOCAL',
      externalId: `local:AST-${suffix}`, ownerId: 'USR-EMPLOYEE', authority: 'L0', processStatus: 'PROCESSED',
      createdAt: '2026-08-11T12:00:00.000Z', updatedAt: '2026-08-11T12:00:00.000Z', isSessionAsset: true, sections: [],
    }))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ conversations: [conversation] }))
      .mockResolvedValueOnce(json({ conversation, messages: [], sessionAssets }))
      .mockResolvedValueOnce(json({ asset: { ...sessionAssets[0], isSessionAsset: false, businessType: 'CUSTOMER_MEETING', ownerId: 'USR-OWNER', authority: 'L1' } }))
    vi.stubGlobal('fetch', fetchMock)

    renderPage()
    expect(await screen.findByRole('option', { name: '客户会议' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '内部会议' })).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByLabelText('资料类型'), 'CUSTOMER_MEETING')
    await userEvent.click(screen.getByRole('button', { name: '提交 会话资料 A.txt 为企业资料' }))

    expect(await screen.findAllByText('会话资料 B.txt')).not.toHaveLength(0)
    expect(screen.queryByText('会话资料 A.txt')).not.toBeInTheDocument()
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/assets/AST-A/promote', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ businessType: 'CUSTOMER_MEETING', ownerId: 'USR-OWNER' }),
    }))
  })

  it('uploads a text Session Asset and promotes it to enterprise material', async () => {
    const sessionAsset = {
      id: 'AST-SESSION', title: '会话说明.txt', assetType: 'DOCUMENT', businessType: 'SESSION_UPLOAD', provider: 'LOCAL',
      externalId: 'local-asset:AST-SESSION', ownerId: 'USR-EMPLOYEE', authority: 'L0', processStatus: 'NEW',
      createdAt: '2026-08-11T12:00:00.000Z', updatedAt: '2026-08-11T12:00:00.000Z', isSessionAsset: true, sections: [],
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ conversations: [] }))
      .mockResolvedValueOnce(json({ asset: sessionAsset }, 201))
      .mockResolvedValueOnce(json({ asset: { ...sessionAsset, processStatus: 'PROCESSED', sections: [{ id: 'SEC-1', title: '部署', locator: 'paragraph:1', excerpt: '轻量部署最低需要 2 张 A800。' }] } }))
      .mockResolvedValueOnce(json({ asset: { ...sessionAsset, processStatus: 'PROCESSED', isSessionAsset: false, businessType: 'PRODUCT_DOCUMENT', ownerId: 'USR-OWNER', authority: 'L1' } }))
    vi.stubGlobal('fetch', fetchMock)

    renderPage()
    const file = new File(['轻量部署最低需要 2 张 A800。'], '会话说明.txt', { type: 'text/plain' })
    await userEvent.upload(await screen.findByLabelText('上传文本资料'), file)

    expect(await screen.findByText('将会话资料提交为企业资料')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '客户会议' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '内部会议' })).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByLabelText('负责人'), 'USR-OWNER')
    await userEvent.click(screen.getByRole('button', { name: '提交 会话说明.txt 为企业资料' }))

    expect(screen.queryByText('会话说明.txt')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '提交 会话说明.txt 为企业资料' })).not.toBeInTheDocument()
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/assets', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ title: '会话说明.txt', assetType: 'DOCUMENT', businessType: 'SESSION_UPLOAD', ownerId: 'USR-EMPLOYEE', content: '轻量部署最低需要 2 张 A800。', mimeType: 'text/plain', isSessionAsset: true }),
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/assets/AST-SESSION/promote', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ businessType: 'PRODUCT_DOCUMENT', ownerId: 'USR-OWNER' }),
    }))
  })

  it('shows a processing failure after a Session Asset was promoted', async () => {
    const sessionAsset = {
      id: 'AST-FAILED-PROMOTE', title: '待提交.txt', assetType: 'DOCUMENT', businessType: 'SESSION_UPLOAD', provider: 'LOCAL',
      externalId: 'local:AST-FAILED-PROMOTE', ownerId: 'USR-EMPLOYEE', authority: 'L0', processStatus: 'NEW',
      createdAt: '2026-08-11T12:00:00.000Z', updatedAt: '2026-08-11T12:00:00.000Z', isSessionAsset: true, sections: [],
    }
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ conversations: [] }))
      .mockResolvedValueOnce(json({ asset: sessionAsset }, 201))
      .mockResolvedValueOnce(json({ asset: { ...sessionAsset, processStatus: 'PROCESSED' } }))
      .mockResolvedValueOnce(json({ asset: {
        ...sessionAsset, processStatus: 'FAILED', isSessionAsset: false, ownerId: 'USR-OWNER', authority: 'L1', errorMessage: '文件解析失败',
      } })))

    renderPage()
    await userEvent.upload(await screen.findByLabelText('上传文本资料'), new File(['内容'], '待提交.txt', { type: 'text/plain' }))
    await userEvent.click(await screen.findByRole('button', { name: '提交 待提交.txt 为企业资料' }))

    expect(await screen.findByText('企业资料已提交，但处理失败：文件解析失败')).toBeInTheDocument()
  })

  it('archives the active conversation and prevents further messages', async () => {
    const conversation = {
      id: 'CVS-ARCHIVE', title: '待归档会话', userId: 'USR-EMPLOYEE', scope: 'ENTERPRISE', sessionAssetIds: [], status: 'ACTIVE',
      messageCount: 2, negativeFeedbackCount: 0, hasOpenIssue: false,
      createdAt: '2026-08-11T12:00:00.000Z', lastActiveAt: '2026-08-11T12:00:00.000Z',
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ conversations: [conversation] }))
      .mockResolvedValueOnce(json({ conversation, messages: [
        { id: 'MSG-U', conversationId: conversation.id, role: 'USER', text: '原问题', citations: [], createdAt: '2026-08-11T12:00:00.000Z' },
        { id: 'MSG-A', conversationId: conversation.id, role: 'ASSISTANT', text: '原回答', citations: [], createdAt: '2026-08-11T12:00:01.000Z' },
      ] }))
      .mockResolvedValueOnce(json({ conversation: { ...conversation, status: 'ARCHIVED' } }))
    vi.stubGlobal('fetch', fetchMock)

    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: '归档会话' }))

    expect(await screen.findByText('此会话已归档。')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('输入你的问题')).toBeDisabled()
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/conversations/CVS-ARCHIVE/archive', expect.objectContaining({ method: 'POST' }))
  })

  it('locks the composer and navigation while archiving', async () => {
    const conversation = {
      id: 'CVS-ARCHIVING', title: '正在归档', userId: 'USR-EMPLOYEE', scope: 'ENTERPRISE', sessionAssetIds: [], status: 'ACTIVE',
      messageCount: 2, negativeFeedbackCount: 0, hasOpenIssue: false,
      createdAt: '2026-08-11T12:00:00.000Z', lastActiveAt: '2026-08-11T12:00:00.000Z',
    }
    const pendingArchive = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ conversations: [conversation] }))
      .mockResolvedValueOnce(json({ conversation, messages: [
        { id: 'MSG-U', conversationId: conversation.id, role: 'USER', text: '原问题', citations: [], createdAt: '2026-08-11T12:00:00.000Z' },
        { id: 'MSG-A', conversationId: conversation.id, role: 'ASSISTANT', text: '原回答', citations: [], createdAt: '2026-08-11T12:00:01.000Z' },
      ], sessionAssets: [] }))
      .mockImplementationOnce(() => pendingArchive.promise))

    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: '归档会话' }))

    expect(screen.getByPlaceholderText('输入你的问题')).toBeDisabled()
    expect(screen.getAllByRole('button', { name: '新对话' }).every((button) => button.hasAttribute('disabled'))).toBe(true)
    expect(screen.getByRole('button', { name: '正在归档' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '归档会话' })).toBeDisabled()

    pendingArchive.resolve(json({ conversation: { ...conversation, status: 'ARCHIVED' } }))
    expect(await screen.findByText('此会话已归档。')).toBeInTheDocument()
  })
})
