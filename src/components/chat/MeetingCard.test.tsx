import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MeetingCard } from './MeetingCard'
import type { MeetingRecord } from '../../../shared/api/product'

const meeting: MeetingRecord = {
  id: 'MT-test', conversationId: 'conversation', state: 'completed', version: 1,
  progress: { message: '完成' }, updatedAt: '2026-09-17T01:00:00Z',
  result: { title: '讨论会议', meetingType: '内部管理', body: '负责人待确认 [S1-P1]' },
  sources: [{ title: '转写', platform: '文字资料', platformSummary: '', completeness: 'COMPLETE', paragraphs: [{ id: 'P1', text: '建议下周继续讨论。', speaker: '未提供' }] }],
}

const followupMeeting: MeetingRecord = {
  ...meeting,
  result: {
    ...meeting.result!,
    followup: {
      coordinator: { userId: '1', displayName: '会议上传者' },
      tasks: [{ id: 'task-1', title: '补充测试方案', assignee: null, assigneeSuggestion: '张工', dueDate: null, status: 'OPEN', sourceRefs: ['S1-P1'] }],
      knowledgeSuggestions: [{ id: 'knowledge-1', title: '更新部署限制', reason: '会议提出了新的限制条件', sourceRefs: ['S1-P1'], status: 'PENDING_MAINTAINER' }],
    },
  },
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); sessionStorage.clear() })

function renderExpanded(ui: Parameters<typeof render>[0]) {
  const view = render(ui)
  for (const summary of document.querySelectorAll('.meeting-task-detail > summary')) fireEvent.click(summary)
  return view
}

describe('meeting results', () => {
  it('opens task evidence from the correct source with timestamp and original link, without saving or sending', () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ users: [] })))
    vi.stubGlobal('fetch', fetcher)
    renderExpanded(<MeetingCard meeting={{ ...followupMeeting,
      sources: [...meeting.sources, { ...meeting.sources[0], title: '第二份转写', url: 'https://bncloud.ieasetek.com/share/example',
        paragraphs: [{ id: 'P1', text: '把一体机带来演示。', speaker: '肖总', startMs: 934000 }],
      }],
      result: { ...followupMeeting.result!, followup: { ...followupMeeting.result!.followup!,
        tasks: [{ ...followupMeeting.result!.followup!.tasks[0], sourceRefs: ['S1-P1', 'S2-P1'] }],
      } },
    }} />)
    const button = screen.getByRole('button', { name: '查看待办依据 S2-P1' })
    fireEvent.click(button)
    const panel = screen.getByRole('region', { name: '待办原文依据' })
    expect(panel).toHaveTextContent('第二份转写')
    expect(panel).toHaveTextContent('肖总 · 00:15:34')
    expect(panel).toHaveTextContent('把一体机带来演示。')
    expect(within(panel).getByRole('link', { name: '查看原始会议' })).toHaveAttribute('href', 'https://bncloud.ieasetek.com/share/example')
    expect(button).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByRole('button', { name: '查看待办依据 S1-P1' }))
    expect(panel).toHaveTextContent('段落 P1')
    expect(panel).toHaveTextContent('建议下周继续讨论。')
    expect(within(panel).queryByRole('link')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '查看待办依据 S1-P1' }))
    expect(screen.queryByRole('region', { name: '待办原文依据' })).not.toBeInTheDocument()
    expect(fetcher.mock.calls.every((args: unknown[]) => !(args[1] as RequestInit | undefined)?.method)).toBe(true)
  })

  it('explains a missing task paragraph instead of showing unrelated evidence', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ users: [] }))))
    renderExpanded(<MeetingCard meeting={{ ...followupMeeting, result: { ...followupMeeting.result!,
      followup: { ...followupMeeting.result!.followup!, tasks: [{ ...followupMeeting.result!.followup!.tasks[0], sourceRefs: ['S1-P999'] }] },
    } }} />)
    fireEvent.click(screen.getByRole('button', { name: '查看待办依据 S1-P999' }))
    expect(screen.getByRole('region', { name: '待办原文依据' })).toHaveTextContent('此依据对应的原文片段暂不可用。')
    expect(screen.queryByText('建议下周继续讨论。')).not.toBeInTheDocument()
  })

  it('shows exact evidence and paragraph locator without inventing a timestamp', () => {
    renderExpanded(<MeetingCard meeting={meeting} />)
    fireEvent.click(screen.getByRole('button', { name: 'S1-P1' }))
    expect(screen.getByText('建议下周继续讨论。')).toBeInTheDocument()
    expect(screen.getByText(/段落 P1/)).toBeInTheDocument()
  })

  it('opens explicitly selected history separately from current paragraph evidence', () => {
    renderExpanded(<MeetingCard meeting={{ ...meeting, result: { ...meeting.result!, body: '历史讨论 [H1]',
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
    const view = renderExpanded(<MeetingCard meeting={meeting} />)
    fireEvent.click(screen.getByRole('button', { name: '手动编辑' }))
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
    renderExpanded(<MeetingCard meeting={meeting} onDirtyChange={dirty} />)
    fireEvent.click(screen.getByRole('button', { name: '手动编辑' }))
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
    renderExpanded(<MeetingCard meeting={meeting} />)
    fireEvent.click(screen.getByRole('button', { name: '手动编辑' }))
    fireEvent.change(screen.getByRole('textbox', { name: '纪要正文（自动保存）' }), { target: { value: '保留我的编辑' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })
    expect(screen.getByRole('textbox', { name: '纪要正文（自动保存）' })).toHaveValue('保留我的编辑')
    expect(screen.getByRole('button', { name: '导出 Word' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '重试保存' })).toBeEnabled()
  })

  it('prefills the source date and sends that date on confirmation without silently saving on view', async () => {
    const suggested = { ...followupMeeting, result: { ...followupMeeting.result!, followup: {
      ...followupMeeting.result!.followup!, tasks: [{ ...followupMeeting.result!.followup!.tasks[0], dueDateSuggestion: '2026年9月21日前' }],
    } } }
    const fetcher = vi.fn(async (_path, init?: RequestInit) => new Response(JSON.stringify(
      init?.method === 'PATCH' ? { meeting: { ...suggested, version: 2 } } : { users: [] },
    )))
    vi.stubGlobal('fetch', fetcher)
    renderExpanded(<MeetingCard meeting={suggested} />)
    expect(screen.getByRole('button', { name: '期限：2026-09-21' })).toBeInTheDocument()
    expect(screen.getByText('原文期限：2026年9月21日前（请核对）')).toBeInTheDocument()
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '确认并发送' }))
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true))
    const call = fetcher.mock.calls.find(([, init]) => init?.method === 'PATCH')!
    expect(JSON.parse(call[1]!.body as string)).toMatchObject({ action: 'CONFIRM', tasks: [{ dueDate: '2026-09-21' }] })
  })

  it('keeps a suggested date cleared after saving and reloading', async () => {
    const suggested = { ...followupMeeting, result: { ...followupMeeting.result!, followup: {
      ...followupMeeting.result!.followup!, tasks: [{ ...followupMeeting.result!.followup!.tasks[0], dueDateSuggestion: '2026年9月21日前' }],
    } } }
    const cleared = { ...suggested, version: 2, result: { ...suggested.result, followup: {
      ...suggested.result.followup, tasks: [{ ...suggested.result.followup.tasks[0], dueDate: null, dueDateEdited: true }],
    } } }
    const fetcher = vi.fn(async (_path, init?: RequestInit) => new Response(JSON.stringify(
      init?.method === 'PATCH' ? { meeting: cleared } : { users: [] },
    )))
    vi.stubGlobal('fetch', fetcher)
    const view = renderExpanded(<MeetingCard meeting={suggested} />)
    fireEvent.click(screen.getByRole('button', { name: '期限：2026-09-21' }))
    fireEvent.click(screen.getByRole('button', { name: '清空日期' }))
    expect(screen.getByRole('button', { name: '期限：待确认' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '保存跟进' }))
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true))
    const call = fetcher.mock.calls.find(([, init]) => init?.method === 'PATCH')!
    expect(JSON.parse(call[1]!.body as string).tasks[0].dueDate).toBeNull()
    view.unmount()
    renderExpanded(<MeetingCard meeting={cleared} />)
    expect(screen.getByRole('button', { name: '期限：待确认' })).toBeInTheDocument()
  })

  it('shows follow-up ownership and saves a tenant directory assignee', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_path, init?: RequestInit) => {
      if (init?.method === 'PATCH') return new Response(JSON.stringify({ meeting: { ...followupMeeting, version: 2 } }))
      return new Response(JSON.stringify({ users: [{ userId: '2', feishuUserId: 'ou_2', displayName: '张工' }] }))
    }))
    renderExpanded(<MeetingCard meeting={followupMeeting} />)
    expect(screen.getByText(/跟进负责人：会议上传者/)).toBeInTheDocument()
    expect(screen.getByText('知识更新建议')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '负责人：待分配' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '张工' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '张工' }))
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-18T12:00:00'))
    fireEvent.click(screen.getByRole('button', { name: '期限：待确认' }))
    fireEvent.click(screen.getByRole('button', { name: '2026-09-30' }))
    vi.useRealTimers()
    expect(screen.getByText(/此版本未记录逐条比对结果/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '保存跟进' }))
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true))
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(([, init]) => init?.method === 'PATCH')!
    expect(JSON.parse(call[1].body).tasks[0]).toMatchObject({ assigneeFeishuUserId: 'ou_2', dueDate: '2026-09-30' })
  })

  it('shows formal knowledge comparison status and evidence for each suggestion', () => {
    renderExpanded(<MeetingCard meeting={{
      ...followupMeeting,
      result: {
        ...followupMeeting.result!,
        formalEvidence: [{ evidence_id: 'E1', title: '交付规范', excerpt: '交付限制说明', source_url: '' }],
        followup: {
          ...followupMeeting.result!.followup!,
          knowledgeSuggestions: [
            { id: 'knowledge-1', title: '更新部署限制', reason: '会议补充了限制条件', sourceRefs: ['S1-P1'], status: 'PENDING_MAINTAINER', comparisonStatus: 'NEEDS_UPDATE', comparison: '已有知识但需要补充。', formalEvidenceIds: ['E1'] },
            { id: 'knowledge-2', title: '新增验收说明', reason: '正式知识未提及', sourceRefs: [], status: 'PENDING_MAINTAINER', comparisonStatus: 'NEW_TOPIC', comparison: '未找到对应内容。', formalEvidenceIds: [] },
          ],
        },
      },
    }} />)
    expect(screen.getByText('已有知识，建议修改')).toBeInTheDocument()
    expect(screen.getByText('正式知识未覆盖，建议新增')).toBeInTheDocument()
    expect(screen.getByText('已有知识但需要补充。')).toBeInTheDocument()
    expect(screen.getAllByText('[E1] 交付规范')).toHaveLength(2)
    expect(screen.getAllByText('交付限制说明')).toHaveLength(2)
  })

  it('adds a manual task and confirms one task for delivery', async () => {
    const fetcher = vi.fn(async (_path, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        const patch = JSON.parse(init.body as string)
        return new Response(JSON.stringify({
          meeting: {
            ...followupMeeting, version: followupMeeting.version + 1,
            result: { ...followupMeeting.result!, followup: { ...followupMeeting.result!.followup!, tasks: patch.tasks } },
          },
        }))
      }
      return new Response(JSON.stringify({ users: [{ userId: '2', feishuUserId: 'ou_2', feishuOpenId: 'ou_open_2', displayName: '张工' }] }))
    })
    vi.stubGlobal('fetch', fetcher)
    renderExpanded(<MeetingCard meeting={followupMeeting} />)
    fireEvent.click(screen.getByRole('button', { name: '＋新增待办' }))
    const manualTitle = screen.getByRole('textbox', { name: '待办标题：未填写' })
    fireEvent.change(manualTitle, { target: { value: '补发会议资料' } })
    fireEvent.click(screen.getByRole('button', { name: '保存跟进' }))
    await waitFor(() => expect(fetcher).toHaveBeenCalled())
    const saveCall = fetcher.mock.calls.find(([, init]) => init?.method === 'PATCH')!
    const savePayload = JSON.parse(saveCall[1]?.body as string) as { action: string; tasks: { id: string; title: string }[] }
    expect(savePayload).toMatchObject({ action: 'SAVE' })
    expect(savePayload.tasks.some(task => task.id.startsWith('manual-') && task.title === '补发会议资料')).toBe(true)
    expect(savePayload.tasks.find(task => task.id.startsWith('manual-'))).toMatchObject({ content: '' })
  })

  it('offers an explicit resend for an already delivered task', async () => {
    const confirmedMeeting: MeetingRecord = {
      ...followupMeeting,
      result: {
        ...followupMeeting.result!,
        followup: {
          ...followupMeeting.result!.followup!,
          tasks: [{
            ...followupMeeting.result!.followup!.tasks[0],
            assignee: { userId: '2', feishuUserId: 'ou_2', feishuOpenId: 'ou_open_2', displayName: '张工' },
            reviewStatus: 'CONFIRMED',
            delivery: { notification: 'SENT', feishuTaskId: 'task_1', messageId: 'om_old', error: null },
          }],
        },
      },
    }
    const fetcher = vi.fn(async (_path, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        const patch = JSON.parse(init.body as string)
        return new Response(JSON.stringify({ meeting: {
          ...confirmedMeeting, version: 2,
          result: { ...confirmedMeeting.result!, followup: { ...confirmedMeeting.result!.followup!, tasks: patch.tasks } },
        } }))
      }
      return new Response(JSON.stringify({ users: [{ userId: '2', feishuUserId: 'ou_2', feishuOpenId: 'ou_open_2', displayName: '张工' }] }))
    })
    vi.stubGlobal('fetch', fetcher)
    renderExpanded(<MeetingCard meeting={confirmedMeeting} />)
    expect(screen.getByText(/飞书已接收发给张工通知/u)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重新发送通知' }))
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true))
    const call = fetcher.mock.calls.find(([, init]) => init?.method === 'PATCH')!
    expect(JSON.parse(call[1]?.body as string)).toMatchObject({ action: 'RESEND', taskId: 'task-1' })
  })

  it('allows correcting a delivered task owner before sending it again', async () => {
    const confirmedTask = {
      ...followupMeeting.result!.followup!.tasks[0],
      assignee: { userId: '2', feishuUserId: 'ou_2', feishuOpenId: 'ou_open_2', displayName: '张工' },
      reviewStatus: 'CONFIRMED' as const,
      delivery: { notification: 'SENT' as const, feishuTaskId: 'task_1', messageId: 'om_old', error: null },
    }
    const confirmedMeeting: MeetingRecord = {
      ...followupMeeting,
      result: { ...followupMeeting.result!, followup: { ...followupMeeting.result!.followup!, tasks: [confirmedTask] } },
    }
    const fetcher = vi.fn(async (_path, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        const patch = JSON.parse(init.body as string)
        const savedTask = { ...confirmedTask, title: patch.tasks[0].title, assignee: { userId: '3', feishuUserId: 'ou_3', displayName: '王工' }, reviewStatus: 'CONFIRMED', delivery: { ...confirmedTask.delivery, pendingUpdate: true } }
        return new Response(JSON.stringify({ meeting: { ...confirmedMeeting, version: 2, result: { ...confirmedMeeting.result!, followup: { ...confirmedMeeting.result!.followup!, tasks: [savedTask] } } } }))
      }
      return new Response(JSON.stringify({ users: [
        { userId: '2', feishuUserId: 'ou_2', displayName: '张工' },
        { userId: '3', feishuUserId: 'ou_3', displayName: '王工' },
      ] }))
    })
    vi.stubGlobal('fetch', fetcher)
    renderExpanded(<MeetingCard meeting={confirmedMeeting} />)
    fireEvent.click(screen.getByRole('button', { name: '修改' }))
    fireEvent.click(screen.getByRole('button', { name: '负责人：张工' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '王工' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '王工' }))
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true))
    const call = fetcher.mock.calls.find(([, init]) => init?.method === 'PATCH')!
    expect(JSON.parse(call[1]?.body as string)).toMatchObject({ action: 'SAVE', tasks: [{ assigneeUserId: '3', assigneeFeishuUserId: 'ou_3' }] })
    expect(screen.getByRole('button', { name: '同步修改到飞书' })).toBeInTheDocument()
  })

  it('preserves a conflicting draft base across reloads until the user reloads the saved version', async () => {
    vi.useFakeTimers()
    sessionStorage.setItem('meeting-edit:MT-test', JSON.stringify({
      body: '本地旧版本修改', title: '讨论会议', meetingType: '内部管理', baseVersion: 1,
    }))
    const newest = { ...meeting, version: 2 }
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ meeting: newest })))
    vi.stubGlobal('fetch', fetcher)
    renderExpanded(<MeetingCard meeting={newest} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })
    expect(fetcher).not.toHaveBeenCalled()
    expect(JSON.parse(sessionStorage.getItem('meeting-edit:MT-test')!).baseVersion).toBe(1)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '放弃本地修改，读取已保存版本' })) })
    expect(screen.getByRole('textbox', { name: '纪要正文（自动保存）' })).toHaveValue(meeting.result!.body)
    expect(sessionStorage.getItem('meeting-edit:MT-test')).toBeNull()
  })

})

it.each(['MODEL_OUTPUT_INVALID', 'MODEL_OUTPUT_TRUNCATED', 'ANALYSIS_FAILED'])('does not suggest replacing the source for %s', code => {
  renderExpanded(<MeetingCard meeting={{ ...meeting, state: 'failed', result: undefined,
    error: { code, message: '分析失败，可重试继续' },
  }} />)
  expect(screen.getByRole('alert')).toHaveTextContent('分析失败，可重试继续')
  expect(screen.queryByText(/替换链接/)).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '重试' })).toBeEnabled()
})

it('offers replacement input when the source is incomplete', () => {
  renderExpanded(<MeetingCard meeting={{ ...meeting, state: 'failed', result: undefined,
    error: { code: 'PARTIAL', message: '原文读取不完整' },
  }} />)
  expect(screen.getByRole('alert')).toHaveTextContent('替换链接')
})

describe('unified meeting tasks', () => {
  it('shows one list, preserves surrounding text and keeps task tables out of the narrative editor', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ users: [] }))))
    render(<MeetingCard meeting={{ ...followupMeeting, result: { ...followupMeeting.result!, body: '## 明确决定\n决定保留\n## 行动清单\n过期的任务表\n## 待确认问题\n问题保留' } }} />)
    expect(screen.getAllByRole('heading', { name: '待办事项' })).toHaveLength(1)
    expect(screen.queryByText('过期的任务表')).not.toBeInTheDocument()
    expect(screen.getByText('决定保留')).toBeInTheDocument()
    expect(screen.getByText('问题保留')).toBeInTheDocument()
    expect(document.querySelector('.meeting-task-detail')).not.toHaveAttribute('open')
    fireEvent.click(screen.getByRole('button', { name: '手动编辑' }))
    const editor = screen.getByRole('textbox', { name: '纪要正文（自动保存）' })
    expect(editor).toHaveValue('## 明确决定\n决定保留\n\n## 待确认问题\n问题保留')
    expect(screen.getByRole('button', { name: '复制' })).toBeEnabled()
  })

  it('keeps a new task expanded while typing and prevents exporting unsaved task changes', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ users: [] }))))
    render(<MeetingCard meeting={followupMeeting} />)
    fireEvent.click(screen.getByRole('button', { name: '＋新增待办' }))
    const input = screen.getByRole('textbox', { name: '待办标题：未填写' })
    fireEvent.change(input, { target: { value: '补漏待办' } })
    expect(input.closest('details')).toHaveAttribute('open')
    expect(screen.getByRole('button', { name: '复制' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '导出 Word' })).toBeDisabled()
  })

  it('copies the versioned saved markdown including current tasks', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/markdown') ? { body: '已保存正文\n## 待办事项\n最新任务' } : { users: [] })))
    vi.stubGlobal('fetch', fetcher)
    render(<MeetingCard meeting={followupMeeting} />)
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('已保存正文\n## 待办事项\n最新任务'))
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('/markdown?version=1'))).toBe(true)
  })

  it('requires explicit acceptance of an AI task proposal and never dispatches it on view', async () => {
    const proposed = { ...followupMeeting, result: { ...followupMeeting.result!, followup: { ...followupMeeting.result!.followup!, tasks: [{ ...followupMeeting.result!.followup!.tasks[0], aiProposal: { title: '建议的标题', assigneeSuggestion: '张工', sourceRefs: [] } }] } } }
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify(init?.method === 'PATCH' ? { meeting: followupMeeting } : { users: [] })))
    vi.stubGlobal('fetch', fetcher)
    renderExpanded(<MeetingCard meeting={proposed} />)
    expect(screen.getByRole('textbox', { name: '待办标题：补充测试方案' })).toHaveValue('补充测试方案')
    expect(fetcher.mock.calls.every(([, init]) => !init?.method)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '采用修改' }))
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true))
    const request = fetcher.mock.calls.find(([, init]) => init?.method === 'PATCH')![1]!
    expect(JSON.parse(request.body as string)).toMatchObject({ action: 'APPLY_AI', taskId: 'task-1' })
    expect(fetcher.mock.calls.some(([, init]) => typeof init?.body === 'string' && /"(CONFIRM|RESEND)"/.test(init.body))).toBe(false)
  })
})
