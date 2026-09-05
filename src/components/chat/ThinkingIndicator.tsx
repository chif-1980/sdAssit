import { Check, ChevronDown, Clock3, FileSearch, LoaderCircle, Search, Sparkles, ShieldCheck, Waypoints, Workflow } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type { ProductAnswerProgress } from '../../../shared/api/product.js'

const stageDefinitions = [
  { key: 'UNDERSTANDING', label: '理解问题', icon: Search },
  { key: 'REQUIREMENTS_ANALYSIS', label: '拆解需求', icon: Search },
  { key: 'CAPABILITY_MATCHING', label: '匹配能力', icon: Waypoints },
  { key: 'RETRIEVING', label: '检索资料', icon: FileSearch },
  { key: 'ARCHITECTURE_DESIGN', label: '设计架构', icon: Workflow },
  { key: 'VERIFYING', label: '核对依据', icon: Check },
  { key: 'EVIDENCE_CHECK', label: '检查证据', icon: ShieldCheck },
  { key: 'QUALITY_REVIEW', label: '质量审核', icon: ShieldCheck },
  { key: 'WAITING_FOR_INPUT', label: '等待补充', icon: Clock3 },
  { key: 'COMPOSING', label: '组织答案', icon: Sparkles },
] as const

type StageKey = typeof stageDefinitions[number]['key']

const stageByKey = new Map<string, typeof stageDefinitions[number]>(stageDefinitions.map((stage) => [stage.key, stage]))

function formatElapsed(elapsedMs: number) {
  const seconds = Math.floor(elapsedMs / 1000)
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

interface ThinkingIndicatorProps {
  progress?: ProductAnswerProgress
  progressTrail?: readonly ProductAnswerProgress[]
  streaming?: boolean
}

export function ThinkingIndicator({ progress, progressTrail = [], streaming = false }: ThinkingIndicatorProps) {
  const [elapsedMs, setElapsedMs] = useState(0)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const progressItems = useMemo(() => [...progressTrail, ...(progress ? [progress] : [])].reduce<ProductAnswerProgress[]>((items, item) => {
    const previous = items.at(-1)
    if (previous?.stage === item.stage) {
      items[items.length - 1] = item
      return items
    }
    items.push(item)
    return items
  }, []), [progress, progressTrail])
  const visibleProgress = progressItems.at(-1) ?? progress
  const detailsVisible = detailsOpen
  const displayedElapsedMs = progress?.elapsedMs && progress.elapsedMs > 0 ? progress.elapsedMs : elapsedMs

  useEffect(() => {
    const startedAt = Date.now()
    const updateElapsed = () => setElapsedMs(Date.now() - startedAt)
    updateElapsed()
    const timer = window.setInterval(updateElapsed, 1_000)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <div
      className={`thinking-card${detailsVisible ? ' is-visible' : ''}${detailsOpen ? ' is-expanded' : ''}`}
      role={streaming ? 'group' : 'status'}
      aria-live="polite"
      aria-label="执行过程"
    >
        <div className="thinking-compact">
          <div className="thinking-summary">
            <span className="thinking-summary-icon" aria-hidden="true">
              {visibleProgress?.status === 'COMPLETED' ? <Check size={14} /> : <LoaderCircle className="thinking-spinner" size={15} />}
            </span>
            <span className="thinking-summary-copy">
              <strong>{visibleProgress ? (stageByKey.get(visibleProgress.stage)?.label ?? visibleProgress.stage) : '正在准备'}</strong>
              <span>{visibleProgress?.message ?? '正在连接知识服务'}</span>
            </span>
          </div>
          <span className="thinking-elapsed"><Clock3 size={13} aria-hidden="true" />{formatElapsed(displayedElapsedMs)}</span>
          {progressItems.length ? (
            <button
              type="button"
              className="thinking-toggle"
              aria-expanded={detailsOpen}
              aria-label={detailsOpen ? '收起执行过程' : '查看执行过程'}
              title={detailsOpen ? '收起执行过程' : '查看执行过程'}
              onClick={() => {
                setDetailsOpen((current) => !current)
              }}
            >
              <span>{detailsOpen ? '收起' : '执行过程'}</span>
              <ChevronDown size={14} aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <div className="thinking-detail" aria-hidden={!detailsOpen}>
          <ol className="thinking-steps" aria-label="已执行的处理阶段">
            {progressItems.map((item, index) => {
              const definition = stageByKey.get(item.stage as StageKey)
              const Icon = definition?.icon ?? Search
              const isLast = index === progressItems.length - 1
              const complete = !isLast || item.status === 'COMPLETED'
              return (
                <li key={`${item.stage}-${index}`} className={`thinking-step${complete ? ' is-complete' : ' is-current'}`}>
                  <span className="thinking-step-marker" aria-hidden="true">
                    {complete ? <Check size={12} /> : <Icon size={13} />}
                  </span>
                  <span className="thinking-step-copy">
                    <strong>{definition?.label ?? item.stage}</strong>
                    <span>{item.message}</span>
                  </span>
                </li>
              )
            })}
          </ol>
          <p className="thinking-hint">
            {displayedElapsedMs >= 12_000
              ? '资料较多，我还在逐条核对来源。完成后会显示可编辑的方案草稿。'
              : '执行过程会随 Agent 的实际动作更新，不会预先展示未执行的阶段。'}
          </p>
        </div>
    </div>
  )
}
