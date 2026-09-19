import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useState, type ComponentProps } from 'react'
import { MeetingActivity } from './MeetingActivity'
function Activity(props: Omit<ComponentProps<typeof MeetingActivity>, 'open' | 'onOpenChange'>) {
  const [open, setOpen] = useState(false)
  return <MeetingActivity {...props} open={open} onOpenChange={setOpen} />
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear() })
it('notifies on completion, remembers read state across refresh and scopes it by user', async () => {
  vi.useFakeTimers()
  let state = 'running'
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ tasks: [{
    id: 'MT-1', conversationId: 'c1', title: '客户交流', state, progress: { message: '提炼纪要' }, updatedAt: state,
  }] }))))
  const onOpen = vi.fn(async () => {})
  const onTasksChange = vi.fn()
  const view = render(<Activity userId="user-a" disabled={false} onOpen={onOpen} onTasksChange={onTasksChange} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(screen.getByText('1 进行中')).toBeInTheDocument()
  expect(onTasksChange).toHaveBeenLastCalledWith([expect.objectContaining({ conversationId: 'c1', state: 'running' })])
  state = 'completed'
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(screen.getByRole('status')).toHaveTextContent('1 个会议任务已结束')
  expect(onTasksChange).toHaveBeenLastCalledWith([expect.objectContaining({ conversationId: 'c1', state: 'completed' })])
  expect(screen.getByLabelText('1 条未读通知')).toBeInTheDocument()
  view.unmount()
  const reloaded = render(<Activity userId="user-a" disabled={false} onOpen={onOpen} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(screen.getByLabelText('1 条未读通知')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /后台任务/ }))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /客户交流/ })) })
  expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'c1' }))
  expect(screen.queryByLabelText('1 条未读通知')).not.toBeInTheDocument()
  reloaded.unmount()
  render(<Activity userId="user-b" disabled={false} onOpen={onOpen} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(screen.queryByLabelText('1 条未读通知')).not.toBeInTheDocument()
})
