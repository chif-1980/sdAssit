import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ReviewDetailPage } from './ReviewDetailPage'

const conflictDetail = {
  review: {
    id: 'RVW-1', title: '轻量部署冲突', reviewType: 'CONFLICT', risk: 'HIGH', status: 'PENDING',
    proposedContent: '轻量部署最低需要 2 张 A800。', currentSnapshot: '标准部署最低需要 4 张 A800。',
    aiSuggestion: '两个场景应分别保留', reviewerId: 'USR-OWNER', createdAt: '2026-08-11T12:00:00.000Z',
  },
  candidate: { id: 'KCD-1', title: '轻量部署', content: '轻量部署最低需要 2 张 A800。', sourceExcerpt: '轻量部署最低需要 2 张 A800。' },
  knowledge: { id: 'KNW-OLD', title: '标准部署', content: '标准部署最低需要 4 张 A800。', version: 2 },
  sourceAsset: { id: 'AST-1', title: '部署指南', authority: 'L1' },
  allowedActions: ['CREATE_KNOWLEDGE', 'UPDATE_KNOWLEDGE', 'KEEP_CURRENT', 'REJECT_CANDIDATE'],
}

function LocationResult() {
  const location = useLocation()
  return <h1>{location.pathname}</h1>
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/factory/reviews/RVW-1']}>
      <Routes>
        <Route path="/factory/reviews/:reviewId" element={<ReviewDetailPage />} />
        <Route path="/factory/knowledge/:knowledgeId" element={<LocationResult />} />
      </Routes>
    </MemoryRouter>,
  )
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('ReviewDetailPage', () => {
  it('renders only server-allowed actions and requires a decision comment', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(conflictDetail), { status: 200 })))
    renderPage()

    expect(await screen.findByRole('button', { name: '创建新知识' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '更新知识' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '发布' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '需要修改' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '驳回' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '转交' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '归档知识' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '创建新知识' }))
    expect(screen.getByRole('button', { name: '确认裁决' })).toBeDisabled()

    await userEvent.type(screen.getByLabelText('审核意见'), '作为独立场景保留')
    expect(screen.getByRole('button', { name: '确认裁决' })).toBeEnabled()
  })

  it('submits the selected action and opens the resulting knowledge', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(conflictDetail), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        review: { ...conflictDetail.review, status: 'RESOLVED', resolutionAction: 'CREATE_KNOWLEDGE' },
        candidate: { ...conflictDetail.candidate, status: 'APPROVED' },
        knowledge: { id: 'KNW-NEW', title: '轻量部署', version: 1, indexStatus: 'INDEXED' },
      }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    renderPage()

    await userEvent.click(await screen.findByRole('button', { name: '创建新知识' }))
    await userEvent.type(screen.getByLabelText('审核意见'), '作为独立场景保留')
    await userEvent.click(screen.getByRole('button', { name: '确认裁决' }))

    expect(await screen.findByRole('heading', { name: '/factory/knowledge/KNW-NEW' })).toBeInTheDocument()
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/reviews/RVW-1/resolve', expect.objectContaining({ method: 'POST' }))
  })
})
