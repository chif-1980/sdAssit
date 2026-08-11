import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AssetListPage } from './AssetListPage'

vi.mock('../session/SessionProvider', () => ({
  useSession: () => ({
    user: { id: 'USR-OWNER', name: '知识负责人', role: 'OWNER' },
    users: [{ id: 'USR-OWNER', name: '知识负责人', role: 'OWNER' }],
  }),
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('AssetListPage', () => {
  it('renders safe business columns and opens an asset detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ assets: [{
      id: 'AST-1', title: '私有化部署说明', businessType: 'PRODUCT_DOCUMENT', authority: 'L1',
      ownerId: 'USR-OWNER', processStatus: 'PROCESSED', candidateCount: 2, reviewCount: 1,
      updatedAt: '2026-08-11T12:00:00.000Z', contentHash: 'secret-hash', tokenCount: 999,
    }] }), { status: 200, headers: { 'content-type': 'application/json' } })))

    render(
      <MemoryRouter initialEntries={['/factory/assets']}>
        <Routes>
          <Route path="/factory/assets" element={<AssetListPage />} />
          <Route path="/factory/assets/:assetId" element={<h1>已打开资料</h1>} />
        </Routes>
      </MemoryRouter>,
    )

    expect(await screen.findByText('私有化部署说明')).toBeInTheDocument()
    expect(screen.getByText('产品文档')).toBeInTheDocument()
    expect(screen.getByText('知识负责人')).toBeInTheDocument()
    expect(screen.queryByText('secret-hash')).not.toBeInTheDocument()
    expect(screen.queryByText('999')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('link', { name: '私有化部署说明' }))
    expect(screen.getByRole('heading', { name: '已打开资料' })).toBeInTheDocument()
  })

  it('offers a retry when loading fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '失败' } }), { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ assets: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    render(<MemoryRouter><AssetListPage /></MemoryRouter>)
    expect(await screen.findByText('资料加载失败')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '重新加载' }))
    expect(await screen.findByText('暂无资料')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
