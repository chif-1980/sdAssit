import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AssetDetailPage } from './AssetDetailPage'

let role: 'OWNER' | 'ADMIN' = 'OWNER'

vi.mock('../session/SessionProvider', () => ({
  useSession: () => ({ user: { id: role === 'ADMIN' ? 'USR-ADMIN' : 'USR-OWNER', name: '当前用户', role } }),
}))

const detail = {
  asset: {
    id: 'AST-1', title: '部署说明', businessType: 'PRODUCT_DOCUMENT', authority: 'L1',
    ownerId: 'USR-OWNER', processStatus: 'PROCESSED', summary: '部署要求摘要',
    sections: [
      { id: 'SEC-1', title: '标准部署', locator: 'paragraph:1', excerpt: '标准部署最低需要 4 张 A800。' },
      { id: 'SEC-2', title: '轻量部署', locator: 'paragraph:2', excerpt: '轻量部署最低需要 2 张 A800。' },
    ],
  },
  candidates: [
    {
      id: 'KCD-1', title: '标准部署要求', content: '标准部署最低需要 4 张 A800。',
      sourceLocator: 'paragraph:1', sourceExcerpt: '标准部署最低需要 4 张 A800。',
      relation: 'NEW', confidence: 0.91, status: 'PENDING', aiReason: '新事实',
    },
    {
      id: 'KCD-2', title: '轻量部署要求', content: '轻量部署最低需要 2 张 A800。',
      sourceLocator: 'paragraph:2', sourceExcerpt: '轻量部署最低需要 2 张 A800。',
      relation: 'CONFLICT', confidence: 0.82, status: 'PENDING', aiReason: '与标准部署场景不同',
    },
  ],
  reviews: [],
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/factory/assets/AST-1']}>
      <Routes><Route path="/factory/assets/:assetId" element={<AssetDetailPage />} /></Routes>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  role = 'OWNER'
})

describe('AssetDetailPage', () => {
  it('links candidate selection to the matching source evidence in both directions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(detail), { status: 200 })))
    renderPage()

    const analysis = await screen.findByRole('region', { name: '候选知识' })
    const source = screen.getByRole('region', { name: '来源内容' })
    const candidate = within(analysis).getByRole('button', { name: /轻量部署要求/ })
    const excerpt = within(source).getByRole('button', { name: /轻量部署最低需要 2 张 A800/ })

    await userEvent.click(candidate)
    expect(candidate).toHaveAttribute('aria-pressed', 'true')
    expect(excerpt).toHaveAttribute('aria-current', 'true')

    await userEvent.click(within(source).getByRole('button', { name: /标准部署最低需要 4 张 A800/ }))
    expect(within(analysis).getByRole('button', { name: /标准部署要求/ })).toHaveAttribute('aria-pressed', 'true')
  })

  it('lets an Admin retry a failed asset and refreshes the detail', async () => {
    role = 'ADMIN'
    const failed = { ...detail, asset: { ...detail.asset, processStatus: 'FAILED', errorMessage: 'UNSUPPORTED_BINARY_FORMAT' } }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(failed), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(detail), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    renderPage()

    const retry = await screen.findByRole('button', { name: '重新处理' })
    await userEvent.click(retry)

    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/assets/AST-1/process', expect.objectContaining({ method: 'POST' }))
    expect(await screen.findByText('处理完成')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重新处理' })).not.toBeInTheDocument()
  })
})
