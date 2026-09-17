import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProductMaterial } from '../../../shared/api/product.js'
import { MaterialResultList } from './MaterialResultList'

const material: ProductMaterial = {
  id: 'AST-1',
  title: '产品说明 v3.2.pdf',
  type: '产品说明',
  fileName: '产品说明 v3.2.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 2_400_000,
  updatedAt: '2026-08-28T12:00:00.000Z',
  summary: '覆盖产品定位和部署要求。',
  status: 'PUBLISHED',
  approvalStatus: 'APPROVED',
  publicationStatus: 'PUBLISHED',
  citation: {
    id: 'CIT-1',
    kind: 'ENTERPRISE_EVIDENCE',
    title: '产品说明 v3.2',
    path: '飞书知识库 / 产品说明',
    locator: 'page:2',
    excerpt: '部署要求。',
    versionAt: '2026-08-28T12:00:00.000Z',
  },
}

afterEach(cleanup)

describe('MaterialResultList', () => {
  it('shows reviewed material metadata and all supported actions', async () => {
    const user = userEvent.setup()
    const onPreview = vi.fn()
    const onDownload = vi.fn()
    const onDistribute = vi.fn()
    render(<MaterialResultList materials={[material]} onPreview={onPreview} onDownload={onDownload} onDistribute={onDistribute} />)

    expect(screen.getByRole('region', { name: '资料检索结果' })).toHaveTextContent('已审核 · 已发布')
    expect(screen.getByText('更新于 2026/08/28')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '打开飞书原文' })).toHaveAttribute('href', '/api/citations/CIT-1/open')

    await user.click(screen.getByRole('button', { name: '查看摘要' }))
    await user.click(screen.getByRole('button', { name: '下载' }))
    await user.click(screen.getByRole('button', { name: '分发' }))
    expect(onPreview).toHaveBeenCalledWith(material, expect.any(HTMLButtonElement))
    expect(onDownload).toHaveBeenCalledWith(material)
    expect(onDistribute).toHaveBeenCalledWith(material)
  })

  it('renders no card when the assistant did not return materials', () => {
    const { container } = render(<MaterialResultList materials={[]} onPreview={vi.fn()} onDownload={vi.fn()} onDistribute={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })
})
