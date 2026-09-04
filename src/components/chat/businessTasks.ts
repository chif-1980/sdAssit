import { BookOpen, ClipboardList, Sparkles } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import type { ProductSkillDefinition, ProductSkillId } from '../../../shared/api/skills.js'
import type { ComposerMention } from './ChatComposer'

export type BusinessTask = 'QA' | ProductSkillId

export interface BusinessTaskDefinition extends ProductSkillDefinition {
  icon: LucideIcon
}

export const skillRegistry: BusinessTaskDefinition[] = [
  {
    id: 'MATERIAL_SEARCH',
    label: '查资料',
    description: '找产品说明、宣传手册和解决方案',
    prompt: '请帮我找一份产品说明、宣传手册和解决方案。',
    icon: BookOpen,
    triggerKeywords: [
      '资料', '文档', '文件', '产品说明', '宣传手册', '宣传册', '解决方案', '白皮书',
      '查一下', '查找', '检索', '搜索', '寻找', '找一下', '找一份', '相关文档',
      '下载', '分发', '原文',
    ],
    availability: 'AVAILABLE',
    stage: 1,
  },
  {
    id: 'SOLUTION_DRAFT',
    label: '做方案 / 汇报',
    description: '输入需求，生成可确认的方案草稿',
    prompt: '我有一条业务需求，请结合企业正式资料生成方案草稿和汇报提纲。',
    icon: Sparkles,
    triggerKeywords: [
      '做方案', '做解决方案', '制定方案', '制定解决方案', '生成方案', '生成解决方案',
      '实施方案', '方案草稿', '方案汇报', '汇报材料', '业务需求', '客户需求', '提纲',
      '售前', '起草方案', '起草汇报', '草稿',
    ],
    availability: 'PLANNED',
    stage: 2,
  },
  {
    id: 'MEETING_ANALYSIS',
    label: '分析会议',
    description: '提炼摘要、待办和产品建议',
    prompt: '请分析我上传的会议纪要，提炼摘要、待办和产品建议。',
    icon: ClipboardList,
    triggerKeywords: ['会议', '纪要', '待办', '行动项'],
    availability: 'PLANNED',
    stage: 3,
  },
]

export const businessTasks = skillRegistry

export const composerMentions: ComposerMention[] = skillRegistry.map((task) => ({
  // Keep the composer shortcut short while the conversation header can use
  // the fuller product label ("做方案 / 汇报").
  value: `@${task.id === 'SOLUTION_DRAFT' ? '做方案' : task.label}`,
  label: task.label,
  description: task.availability === 'PLANNED'
    ? `${task.description} · 第 ${task.stage} 阶段开放`
    : task.description,
}))

export function taskDefinition(task: BusinessTask) {
  return skillRegistry.find((item) => item.id === task)
}

export function inferBusinessTask(input: string): BusinessTask {
  const matched = skillRegistry
    .map((skill) => ({ skill, score: skill.triggerKeywords.reduce((score, keyword) => score + (input.includes(keyword) ? 1 : 0), 0) }))
    .sort((left, right) => right.score - left.score)[0]
  return matched && matched.score > 0 ? matched.skill.id : 'QA'
}
