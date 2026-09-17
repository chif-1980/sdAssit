import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MeetingCard } from './MeetingCard'
import type { MeetingRecord } from '../../../shared/api/product'

const meeting: MeetingRecord = {
  id: 'MT-test', conversationId: 'conversation', state: 'completed', version: 1,
  progress: { message: '完成' }, updatedAt: '2026-09-17T01:00:00Z',
  result: { title: '讨论会议', meetingType: '内部管理', body: '负责人待确认 [S1-P1]' },
  sources: [{ title: '转写', platform: '文字资料', platformSummary: '', completeness: 'COMPLETE', paragraphs: [{ id: 'P1', text: '建议下周继续讨论。', speaker: '未提供' }] }],
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); sessionStorage.clear() })

describe('meeting results', () => {
  it('shows exact evidence and paragraph locator without inventing a timestamp', () => {
    render(<MeetingCard meeting={meeting} />)
    fireEvent.click(screen.getByRole('button', { name: 'S1-P1' }))
    expect(screen.getByText('建议下周继续讨论。')).toBeInTheDocument()
    expect(screen.getByText(/段落 P1/)).toBeInTheDocument()
  })

  it('opens explicitly selected history separately from current paragraph evidence', () => {
    render(<MeetingCard meeting={{ ...meeting, result: { ...meeting.result!, body: '历史讨论 [H1]',
      selectedHistory: [{ id: 'old', label: 'H1', title: '上次会议', body: '历史决定 [S1-P1]' }],
    } }} />)
    fireEvent.click(screen.getByRole('button', { name: 'H1' }))
    expect(screen.getByRole('complementary', { name: '历史会议依据' })).toHaveTextContent('历史决定')
    expect(screen.queryByRole('complementary', { name: '原文依据' })).not.toBeInTheDocument()
  })

  it('does not overwrite unsaved edits or silently rebase them when server props refresh', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const view = render(<MeetingCard meeting={meeting} />)
    fireEvent.click(screen.getByRole('button', { name: '编辑正文' }))
    fireEvent.change(screen.getByRole('textbox', { name: '纪要正文（自动保存）' }), { target: { value: '本地修改' } })
    view.rerender(<MeetingCard meeting={{ ...meeting, version: 2, result: { ...meeting.result!, body: '另一处修改' } }} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })
    expect(screen.getByRole('textbox', { name: '纪要正文（自动保存）' })).toHaveValue('本地修改')
    expect(fetcher).not.toHaveBeenCalled()
    expect(JSON.parse(sessionStorage.getItem('meeting-edit:MT-test')!).baseVersion).toBe(1)
  })

  it('drains edits made during an in-flight autosave using the returned version', async () => {
    vi.useFakeTimers()
    let resolveFirst!: (response: Response) => void
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { resolveFirst = resolve }))
      .mockImplementationOnce(async (_path, init) => {
        const patch = JSON.parse(init.body)
        return new Response(JSON.stringify({ meeting: { ...meeting, version: 3, result: patch } }))
      })
    vi.stubGlobal('fetch', fetcher)
    const dirty = vi.fn()
    render(<MeetingCard meeting={meeting} onDirtyChange={dirty} />)
    fireEvent.click(screen.getByRole('button', { name: '编辑正文' }))
    fireEvent.change(screen.getByRole('textbox', { name: '纪要正文（自动保存）' }), { target: { value: '第一次修改' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })
    fireEvent.change(screen.getByRole('textbox', { name: '纪要正文（自动保存）' }), { target: { value: '第二次修改' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })
    await act(async () => { resolveFirst(new Response(JSON.stringify({ meeting: {
      ...meeting, version: 2, result: { ...meeting.result, body: '第一次修改' },
    } }))) })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({ version: 2, body: '第二次修改' })
    expect(screen.getByText('版本 3')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '导出 Word' })).toBeEnabled()
    expect(dirty).toHaveBeenLastCalledWith('MT-test', false)
  })

  it('keeps unsaved text and offers retry after a conflict', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: '版本已变化' }), { status: 409 })))
    render(<MeetingCard meeting={meeting} />)
    fireEvent.click(screen.getByRole('button', { name: '编辑正文' }))
    fireEvent.change(screen.getByRole('textbox', { name: '纪要正文（自动保存）' }), { target: { value: '保留我的编辑' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })
    expect(screen.getByRole('textbox', { name: '纪要正文（自动保存）' })).toHaveValue('保留我的编辑')
    expect(screen.getByRole('button', { name: '导出 Word' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '重试保存' })).toBeEnabled()
  })
  it('preserves a conflicting draft base across reloads until the user reloads the saved version', async () => {
    vi.useFakeTimers()
    sessionStorage.setItem('meeting-edit:MT-test', JSON.stringify({
      body: '本地旧版本修改', title: '讨论会议', meetingType: '内部管理', baseVersion: 1,
    }))
    const newest = { ...meeting, version: 2 }
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ meeting: newest })))
    vi.stubGlobal('fetch', fetcher)
    render(<MeetingCard meeting={newest} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })
    expect(fetcher).not.toHaveBeenCalled()
    expect(JSON.parse(sessionStorage.getItem('meeting-edit:MT-test')!).baseVersion).toBe(1)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '放弃本地修改，读取已保存版本' })) })
    expect(screen.getByRole('textbox', { name: '纪要正文（自动保存）' })).toHaveValue(meeting.result!.body)
    expect(sessionStorage.getItem('meeting-edit:MT-test')).toBeNull()
  })

})
