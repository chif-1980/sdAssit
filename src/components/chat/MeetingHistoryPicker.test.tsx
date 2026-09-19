import { useState } from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import type { MeetingHistoryItem, MeetingHistoryPage } from '../../../shared/api/product'
import { MeetingHistoryPicker } from './MeetingHistoryPicker'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function item(id: string, changes: Partial<MeetingHistoryItem> = {}): MeetingHistoryItem {
  return { id, groupId: id, conversationId: 'C1', title: '同名会议', createdAt: '2026-09-19T01:00:00Z',
    platforms: ['BuddyNote'], sourceUrls: ['https://example.com/meeting/' + id], preview: '纪要摘要 ' + id,
    versionCount: 1, ...changes }
}
function response(meetings: MeetingHistoryItem[], changes: Partial<MeetingHistoryPage> = {}) {
  return new Response(JSON.stringify({ meetings, total: meetings.length, nextOffset: null, ...changes }))
}
function Picker({ disabled = false }: { disabled?: boolean }) {
  const [ids, setIds] = useState<string[]>([])
  return <><MeetingHistoryPicker selectedIds={ids} onChange={setIds} disabled={disabled} /><output aria-label="所选编号">{ids.join(',')}</output></>
}

it('distinguishes names by time, previews sources, paginates and retains selections across searches', async () => {
  const a = item('A'), b = item('B', { createdAt: '2026-09-18T01:00:00Z' }), c = item('C', { title: '预算会议' })
  const fetcher = vi.fn(async (path: string) => {
    const params = new URL(path, 'http://localhost').searchParams
    if (params.get('q')) return response([c])
    if (params.get('offset') === '20') return response([b], { total: 2 })
    return response([a], { total: 2, nextOffset: 20 })
  })
  vi.stubGlobal('fetch', fetcher)
  const user = userEvent.setup()
  render(<Picker />)
  await user.click(screen.getByText('引用历史会议'))
  await user.click(await screen.findByRole('checkbox', { name: /同名会议.*2026\/9\/19/ }))
  await user.click(screen.getByText('预览纪要'))
  expect(screen.getByText('纪要摘要 A')).toBeVisible()
  expect(screen.getByRole('link', { name: '查看原始来源' })).toHaveAttribute('href', a.sourceUrls[0])
  await user.click(screen.getByRole('button', { name: '加载更多会议' }))
  expect(await screen.findByRole('checkbox', { name: /同名会议.*2026\/9\/18/ })).not.toBeChecked()
  await user.type(screen.getByRole('searchbox', { name: '搜索历史会议' }), '预算')
  await user.click(await screen.findByRole('checkbox', { name: /预算会议/ }))
  expect(screen.getByLabelText('所选编号')).toHaveTextContent('A,C')
  const selected = screen.getByLabelText('已选历史会议')
  expect(within(selected).getByText('同名会议')).toBeVisible()
  await user.click(within(selected).getByRole('button', { name: /移除 同名会议/ }))
  expect(screen.getByLabelText('所选编号')).toHaveTextContent('C')
})

it('loads historical versions on demand and replaces rather than duplicates the chosen meeting', async () => {
  const latest = item('latest', { groupId: 'original', versionCount: 2 })
  const old = item('original', { groupId: 'original', createdAt: '2026-09-18T01:00:00Z', versionCount: 2 })
  const fetcher = vi.fn(async (path: string) => response(path.includes('groupId=original') ? [latest, old] : [latest]))
  vi.stubGlobal('fetch', fetcher)
  const user = userEvent.setup()
  render(<Picker />)
  await user.click(screen.getByText('引用历史会议'))
  await user.click(await screen.findByRole('checkbox'))
  expect(fetcher).toHaveBeenCalledTimes(1)
  await user.click(screen.getByRole('button', { name: '历史分析版本（2）' }))
  await user.click(await screen.findByRole('checkbox', { name: /2026\/9\/18/ }))
  expect(screen.getByLabelText('所选编号')).toHaveTextContent(/^original$/)
  expect(within(screen.getByLabelText('已选历史会议')).getAllByRole('button')).toHaveLength(1)
  await user.click(screen.getByRole('button', { name: '收起历史版本' }))
  expect(screen.queryByRole('checkbox', { name: /2026\/9\/18/ })).not.toBeInTheDocument()
})

it('shows retry on failures and enforces the existing five-meeting limit', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 500 }))
    .mockImplementation(async () => response(Array.from({ length: 6 }, (_, i) => item(String(i), { title: '会议' + i }))))
  vi.stubGlobal('fetch', fetcher)
  const user = userEvent.setup()
  render(<Picker />)
  await user.click(screen.getByText('引用历史会议'))
  expect(await screen.findByRole('alert')).toHaveTextContent('历史会议加载失败')
  await user.click(screen.getByRole('button', { name: '重试' }))
  await screen.findByRole('checkbox', { name: /会议0/ })
  for (const checkbox of screen.getAllByRole('checkbox').slice(0, 5)) await user.click(checkbox)
  expect(screen.getByRole('checkbox', { name: /会议5/ })).toBeDisabled()
  await user.click(screen.getByRole('checkbox', { name: /会议0/ }))
  expect(screen.getByRole('checkbox', { name: /会议5/ })).toBeEnabled()
})

it('ignores a stale search response and blocks selections when the conversation is locked', async () => {
  let finishOld!: (value: Response) => void
  vi.stubGlobal('fetch', vi.fn((path: string) => path.includes('q=new')
    ? Promise.resolve(response([item('new', { title: '新结果' })]))
    : new Promise<Response>(resolve => { finishOld = resolve })))
  const user = userEvent.setup()
  render(<Picker disabled />)
  await user.click(screen.getByText('引用历史会议'))
  await waitFor(() => expect(finishOld).toBeDefined())
  await user.type(screen.getByRole('searchbox'), 'new')
  expect(await screen.findByRole('checkbox', { name: /新结果/ })).toBeDisabled()
  finishOld(response([item('old', { title: '过期结果' })]))
  await waitFor(() => expect(screen.queryByRole('checkbox', { name: /过期结果/ })).not.toBeInTheDocument())
})
