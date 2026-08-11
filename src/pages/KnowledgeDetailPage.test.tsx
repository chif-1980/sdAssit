import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { KnowledgeDetailPage } from './KnowledgeDetailPage'

let role: 'OWNER' | 'ADMIN' = 'OWNER'

vi.mock('../session/SessionProvider', () => ({
  useSession: () => ({
    user: { id: role === 'ADMIN' ? 'USR-ADMIN' : 'USR-OWNER', name: '知识负责人', role },
    users: [{ id: 'USR-OWNER', name: '知识负责人', role: 'OWNER' }],
  }),
}))

const detail = {
  knowledge: {
    id: 'KNW-1', title: '标准部署要求', content: '标准部署最低需要 4 张 A800。', category: 'TECHNICAL',
    tags: ['部署'], authority: 'L1', ownerId: 'USR-OWNER', primaryAssetId: 'AST-1', supportingAssetIds: ['AST-2'],
    sourceLocator: 'paragraph:1', status: 'ACTIVE', version: 3, lastVerifiedAt: '2026-08-11T12:00:00.000Z',
    aiEnabled: true, indexStatus: 'INDEXED', createdAt: '2026-08-10T12:00:00.000Z', updatedAt: '2026-08-11T12:00:00.000Z',
  },
  primaryAsset: { id: 'AST-1', title: '标准部署指南', authority: 'L1' },
  supportingAssets: [{ id: 'AST-2', title: '轻量部署补充', authority: 'L1' }],
  history: [{ id: 'RVW-1', title: '部署参数更新', reviewType: 'UPDATE', status: 'RESOLVED', resolutionAction: 'UPDATE_KNOWLEDGE', createdAt: '2026-08-11T11:00:00.000Z' }],
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/factory/knowledge/KNW-1']}>
      <Routes><Route path="/factory/knowledge/:knowledgeId" element={<KnowledgeDetailPage />} /></Routes>
    </MemoryRouter>,
  )
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); role = 'OWNER' })

describe('KnowledgeDetailPage', () => {
  it('shows evidence, version, index status, and review history', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(detail), { status: 200 })))
    renderPage()

    expect(await screen.findByText('标准部署最低需要 4 张 A800。')).toBeInTheDocument()
    expect(screen.getByText('版本 3')).toBeInTheDocument()
    expect(screen.getByText('INDEXED')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '标准部署指南' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '轻量部署补充' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '部署参数更新' })).toBeInTheDocument()
  })

  it('creates update and archive reviews without directly modifying knowledge', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(detail), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ review: { id: 'RVW-UPDATE', reviewType: 'UPDATE', status: 'PENDING' } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ review: { id: 'RVW-ARCHIVE', reviewType: 'STALE', status: 'PENDING' } }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    renderPage()

    await userEvent.click(await screen.findByRole('button', { name: '申请更新' }))
    await userEvent.clear(screen.getByLabelText('正式内容'))
    await userEvent.type(screen.getByLabelText('正式内容'), '更新后的部署要求')
    await userEvent.type(screen.getByLabelText('申请原因'), '参数已经调整')
    await userEvent.click(screen.getByRole('button', { name: '创建审核' }))
    expect(await screen.findByRole('link', { name: '查看更新审核' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '申请归档' }))
    await userEvent.type(screen.getByLabelText('归档原因'), '产品已经下线')
    await userEvent.click(screen.getByRole('button', { name: '创建归档审核' }))
    expect(await screen.findByRole('link', { name: '查看归档审核' })).toBeInTheDocument()

    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/knowledge/KNW-1/request-update', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ proposedContent: '更新后的部署要求', decisionComment: '参数已经调整' }),
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/knowledge/KNW-1/request-update', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ intent: 'ARCHIVE', decisionComment: '产品已经下线' }),
    }))
    expect(screen.getByText('标准部署最低需要 4 张 A800。')).toBeInTheDocument()
  })

  it('preserves the update form when review creation fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(detail), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '失败' } }), { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    renderPage()

    await userEvent.click(await screen.findByRole('button', { name: '申请更新' }))
    await userEvent.clear(screen.getByLabelText('正式内容'))
    await userEvent.type(screen.getByLabelText('正式内容'), '仍需保留的编辑内容')
    await userEvent.type(screen.getByLabelText('申请原因'), '仍需保留的原因')
    await userEvent.click(screen.getByRole('button', { name: '创建审核' }))

    expect(await screen.findByText('创建审核失败，编辑内容已保留')).toBeInTheDocument()
    expect(screen.getByLabelText('正式内容')).toHaveValue('仍需保留的编辑内容')
    expect(screen.getByLabelText('申请原因')).toHaveValue('仍需保留的原因')
  })

  it('lets an Admin rebuild a failed index', async () => {
    role = 'ADMIN'
    const failed = { ...detail, knowledge: { ...detail.knowledge, indexStatus: 'FAILED' } }
    const indexed = { ...detail, knowledge: { ...detail.knowledge, indexStatus: 'INDEXED' } }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(failed), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(indexed), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    renderPage()

    await userEvent.click(await screen.findByRole('button', { name: '重建索引' }))

    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/knowledge/KNW-1/reindex', expect.objectContaining({ method: 'POST' }))
    expect(await screen.findByText('INDEXED')).toBeInTheDocument()
  })
})
