import type { MeetingFollowupTask } from '../../../shared/api/product'

export function meetingTaskDate(task: MeetingFollowupTask): string {
  if (task.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(task.dueDate)) return task.dueDate
  // A saved/cleared deadline or an already handled task must not be reinterpreted.
  if (task.dueDateEdited || task.delivery?.feishuTaskId || (task.reviewStatus && task.reviewStatus !== 'PENDING')) return ''
  const text = (task.dueDateSuggestion || task.dueDate || '').trim()
    .replace(/^(?:截至|截止(?:到)?)[:：]?\s*/, '')
    .replace(/(?:之前|前|截止)$/, '').trim()
  const parts = text.match(/^(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日$/)
    || text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/)
  if (!parts) return ''
  const [, year, month, day] = parts.map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return ''
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}
