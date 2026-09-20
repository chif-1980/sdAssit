import { expect, it } from 'vitest'
import type { MeetingFollowupTask } from '../../../shared/api/product'
import { meetingTaskDate } from './meetingTaskDate'

const task: MeetingFollowupTask = { id: 'task', title: '核对手册', assignee: null, dueDate: null, status: 'OPEN', sourceRefs: [] }
it.each(['2026年9月21日前', '截至2026年9月21日', '2026/9/21', '2026-09-21', '2026.9.21之前'])(
  'prefills an explicit deadline: %s', dueDateSuggestion => {
    expect(meetingTaskDate({ ...task, dueDateSuggestion })).toBe('2026-09-21')
  },
)
it.each(['尽快', '下周一', '9月21日', '2026年2月29日', '2026-13-01', '2026年9月21日至2026年9月23日', '']) (
  'does not invent or resolve an ambiguous deadline: %s', dueDateSuggestion => {
    expect(meetingTaskDate({ ...task, dueDateSuggestion })).toBe('')
  },
)
it('retains manual deadlines, explicit clears and already handled tasks', () => {
  const suggested = { ...task, dueDateSuggestion: '2026年9月21日前' }
  expect(meetingTaskDate({ ...suggested, dueDate: '2026-09-25' })).toBe('2026-09-25')
  expect(meetingTaskDate({ ...suggested, dueDateEdited: true })).toBe('')
  expect(meetingTaskDate({ ...suggested, reviewStatus: 'CONFIRMED' })).toBe('')
  expect(meetingTaskDate({ ...suggested, reviewStatus: 'IGNORED' })).toBe('')
  expect(meetingTaskDate({ ...task, dueDateSuggestion: '2028年2月29日' })).toBe('2028-02-29')
})
