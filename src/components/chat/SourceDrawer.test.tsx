import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { SourceDrawer } from './SourceDrawer'

const citation = {
  knowledgeId: 'KNW-1',
  title: '标准部署要求',
  assetId: 'AST-1',
  locator: 'paragraph:1',
  excerpt: '标准部署最低需要 4 张 A800。',
}

afterEach(cleanup)

describe('SourceDrawer', () => {
  it('shows the asset link only to users who can open factory assets', () => {
    const { rerender } = render(<SourceDrawer citation={citation} canViewAsset={false} onClose={() => undefined} />)
    expect(screen.queryByRole('link', { name: '查看资料' })).not.toBeInTheDocument()

    rerender(<SourceDrawer citation={citation} canViewAsset onClose={() => undefined} />)
    expect(screen.getByRole('link', { name: '查看资料' })).toHaveAttribute('href', '/factory/assets/AST-1')
  })
})
