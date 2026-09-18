import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MeetingDatePicker } from './MeetingDatePicker'

afterEach(cleanup)
it('selects leap-day, navigates months and clears a deadline without inventing one', () => {
  const change = vi.fn()
  render(<MeetingDatePicker value="2028-02-01" onChange={change} />)
  fireEvent.click(screen.getByRole('button', { name: '期限：2028-02-01' }))
  expect(change).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: '2028-02-30' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '下个月' }))
  expect(screen.getByRole('button', { name: '2028-03-31' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '上个月' }))
  fireEvent.click(screen.getByRole('button', { name: '2028-02-29' }))
  expect(change).toHaveBeenLastCalledWith('2028-02-29')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '期限：2028-02-01' }))
  fireEvent.click(screen.getByRole('button', { name: '清空日期' }))
  expect(change).toHaveBeenLastCalledWith(null)
})
