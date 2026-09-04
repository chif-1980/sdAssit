import { describe, expect, it } from 'vitest'

import { inferBusinessTask } from './businessTasks'

describe('business skill inference', () => {
  it('keeps ordinary questions that mention a solution as regular Q&A', () => {
    expect(inferBusinessTask('请结合方案回答这个问题')).toBe('QA')
  })

  it('detects explicit solution drafting intent', () => {
    expect(inferBusinessTask('请根据客户需求生成一份实施方案')).toBe('SOLUTION_DRAFT')
  })

  it('detects meeting notes intent without requiring a customer', () => {
    expect(inferBusinessTask('请分析内部产品讨论纪要并列出待办')).toBe('MEETING_ANALYSIS')
  })
})
