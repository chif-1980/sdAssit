import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProductCitation } from '../../../shared/api/product.js'
import { SourceDrawer } from './SourceDrawer'

const citation: ProductCitation = {
  id: 'CIT-1',
  kind: 'ENTERPRISE_EVIDENCE',
  title: '标准部署要求',
  path: '技术中心 / 部署手册',
  locator: '第 4 页',
  excerpt: '标准部署最低需要 4 张 A800。',
  versionAt: '2026-08-12T00:00:00.000Z',
}

afterEach(cleanup)

describe('SourceDrawer', () => {
  it('shows source details and always links to the Feishu original', () => {
    render(<SourceDrawer citation={citation} modal={false} onClose={vi.fn()} />)

    expect(screen.getByRole('dialog', { name: '来源详情' })).toHaveAttribute('id', 'source-drawer')
    expect(screen.getByRole('dialog', { name: '来源详情' })).not.toHaveAttribute('aria-modal')
    expect(screen.getByRole('heading', { name: '标准部署要求' })).toBeInTheDocument()
    expect(screen.getByText('技术中心 / 部署手册')).toBeInTheDocument()
    expect(screen.getByText('第 4 页')).toBeInTheDocument()
    expect(screen.getByText('标准部署最低需要 4 张 A800。')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '打开飞书原文' })).toHaveAttribute('href', '/api/citations/CIT-1/open')
    expect(document.body.innerHTML).not.toContain('/factory/assets')
  })

  it('offers an accessible close action', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<SourceDrawer citation={citation} modal={false} onClose={onClose} />)

    await user.click(screen.getByRole('button', { name: '关闭来源' }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('moves focus inside, contains Tab navigation, and closes with Escape', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<SourceDrawer citation={citation} modal onClose={onClose} />)

    const close = screen.getByRole('button', { name: '关闭来源' })
    const originalLink = screen.getByRole('link', { name: '打开飞书原文' })
    expect(close).toHaveFocus()

    await user.tab({ shift: true })
    expect(originalLink).toHaveFocus()
    await user.tab()
    expect(close).toHaveFocus()
    await user.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not trap focus when rendered as a desktop side panel', async () => {
    const user = userEvent.setup()
    render(
      <>
        <button type="button">外部操作</button>
        <SourceDrawer citation={citation} modal={false} onClose={vi.fn()} />
      </>,
    )

    expect(screen.getByRole('button', { name: '关闭来源' })).toHaveFocus()
    await user.tab({ shift: true })

    expect(screen.getByRole('button', { name: '外部操作' })).toHaveFocus()
  })
})
