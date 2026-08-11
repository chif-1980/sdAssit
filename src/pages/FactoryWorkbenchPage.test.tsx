import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FactoryWorkbenchPage } from './FactoryWorkbenchPage'

vi.mock('../session/SessionProvider', () => ({
  useSession: () => ({ user: { id: 'USR-OWNER', name: '知识负责人', role: 'OWNER' } }),
}))

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('FactoryWorkbenchPage', () => {
  it('shows only the four operational signals and prioritizes pending work', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/reviews')) return json({ reviews: [
        { id: 'RVW-HIGH', title: '部署参数冲突', reviewType: 'CONFLICT', risk: 'HIGH', status: 'PENDING', createdAt: '2026-08-11T12:00:00.000Z' },
        { id: 'RVW-LOW', title: '新增术语', reviewType: 'NEW', risk: 'LOW', status: 'PENDING', createdAt: '2026-08-11T13:00:00.000Z' },
      ] })
      if (url.startsWith('/api/knowledge')) return json({ knowledge: [
        { id: 'KNW-STALE', title: '旧部署说明', status: 'STALE' },
      ] })
      if (url.startsWith('/api/assets')) return json({ assets: [
        { id: 'AST-1', title: '部署指南', processStatus: 'PROCESSED', updatedAt: '2026-08-11T14:00:00.000Z' },
        { id: 'AST-2', title: '处理中资料', processStatus: 'PROCESSING', updatedAt: '2026-08-11T15:00:00.000Z' },
      ] })
      return json({}, 404)
    }))

    render(<MemoryRouter><FactoryWorkbenchPage /></MemoryRouter>)

    expect(await screen.findByRole('heading', { name: '工作台' })).toBeInTheDocument()
    const signals = screen.getByRole('region', { name: '运营信号' })
    expect(within(signals).getByText('待审核')).toBeInTheDocument()
    expect(within(signals).getByText('冲突')).toBeInTheDocument()
    expect(within(signals).getByText('待复核知识')).toBeInTheDocument()
    expect(within(signals).getByText('最近处理资料')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /部署参数冲突/ })).toBeInTheDocument()
    expect(screen.getByText('部署指南')).toBeInTheDocument()
    expect(screen.queryByText(/Token|调用量|模型|Embedding/i)).not.toBeInTheDocument()
  })
})
