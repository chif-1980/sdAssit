import { describe, expect, it } from 'vitest'
import { editableMeetingBody, splitMeetingBody } from './meetingContent'

describe('meeting narrative boundaries', () => {
  it('removes only task sections, including nested headings, and preserves quoted code', () => {
    const before = '## 决定\n保留\n```md\n## 行动清单\n代码示例\n```'
    const [a, b] = splitMeetingBody(`${before}\n## 三、行动清单\n旧任务\n### 细节\n旧要求\n## 待确认问题\n保留问题`)
    expect(a).toBe(before)
    expect(b).toBe('## 待确认问题\n保留问题')
  })
  it('preserves legacy action text if structured tasks do not exist', () => {
    const body = '## 行动清单\n唯一的旧任务'
    expect(editableMeetingBody({ title: '历史', meetingType: '其他', body })).toBe(body)
  })
})
