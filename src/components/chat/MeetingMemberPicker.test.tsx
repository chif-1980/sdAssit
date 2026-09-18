import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MeetingMemberPicker } from './MeetingMemberPicker'
afterEach(cleanup)
it('finds enterprise members by Chinese, English, full pinyin and initials, and supports departments', () => {
  const select = vi.fn()
  render(<MeetingMemberPicker value={null} loading={false} error="" notice="可见范围" onRetry={vi.fn()} onChange={select}
    departments={[{ id: '0', parentId: null, name: '企业' }, { id: 'sales', parentId: '0', name: '销售部' }]}
    users={[{ userId: null, feishuUserId: 'fs1', displayName: '张三', englishName: 'Sam', departmentIds: ['sales'] },
      { userId: '2', feishuUserId: 'fs2', displayName: '李四', departmentIds: ['0'] }]} />)
  fireEvent.click(screen.getByRole('button', { name: '负责人：待分配' }))
  for (const query of ['张三', 'sam', 'zhang san', 'zs']) {
    fireEvent.change(screen.getByRole('textbox', { name: '搜索企业成员' }), { target: { value: query } })
    expect(screen.getByRole('button', { name: /张三 · Sam/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /李四/ })).not.toBeInTheDocument()
  }
  fireEvent.click(screen.getByRole('button', { name: '销售部' }))
  expect(screen.queryByRole('button', { name: /李四/ })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /张三 · Sam/ }))
  expect(select).toHaveBeenCalledWith(expect.objectContaining({ userId: null, feishuUserId: 'fs1' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
