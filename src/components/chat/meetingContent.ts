import type { MeetingRecord } from '../../../shared/api/product'

// Legacy bodies can still contain the model's original task table. Keep it only
// when no structured task data exists, so old meetings never lose their content.
export function splitMeetingBody(body: string): [string, string] {
  const lines = body.split('\n')
  const headings: {start: number; level: number; title: string}[] = []
  let fence = ''
  lines.forEach((line, start) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (marker) {
      if (!fence) fence = marker[1]
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = ''
      return
    }
    if (fence) return
    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (heading) headings.push({start, level: heading[1].length, title: heading[2].replace(/[*_`#]/g, '').trim()})
  })
  const sections = headings.flatMap((h, i) => /^(?:[一二三四五六七八九十\d]+[、.．)）]\s*)?(?:行动清单|行动项|待办事项|待办清单)(?:[（(].*[）)])?$/.test(h.title)
    ? [{ start: h.start, end: headings.slice(i + 1).find(next => next.level <= h.level)?.start ?? lines.length }] : [])
  if (sections.length) {
    const start = sections[0].start
    return [lines.slice(0, start).join('\n').trimEnd(), lines.filter((_, i) => i >= start && !sections.some(s => i >= s.start && i < s.end)).join('\n').trim()]
  }
  const start = headings.find(h => /^(待确认问题|业务分析|企业正式资料)/.test(h.title))?.start ?? lines.length
  return [lines.slice(0, start).join('\n').trimEnd(), lines.slice(start).join('\n').trim()]
}

export function editableMeetingBody(result: MeetingRecord['result']): string {
  const body = result?.body ?? ''
  return result?.followup ? splitMeetingBody(body).filter(Boolean).join('\n\n') : body
}
