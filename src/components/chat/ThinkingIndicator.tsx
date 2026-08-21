import { Check, ChevronDown, Clock3, FileSearch, Search, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { ProductAnswerProgress } from '../../../shared/api/product.js'

const stages = [
  { key: 'UNDERSTANDING', label: '理解问题', icon: Search },
  { key: 'RETRIEVING', label: '检索资料', icon: FileSearch },
  { key: 'VERIFYING', label: '核对依据', icon: Check },
  { key: 'COMPOSING', label: '组织答案', icon: Sparkles },
] as const

const STAGE_VISIBILITY_MS = 600

function formatElapsed(elapsedMs: number) {
  const seconds = Math.floor(elapsedMs / 1000)
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

interface ThinkingIndicatorProps {
  progress?: ProductAnswerProgress
  progressTrail?: readonly ProductAnswerProgress[]
}

export function ThinkingIndicator({ progress, progressTrail = [] }: ThinkingIndicatorProps) {
  const [elapsedMs, setElapsedMs] = useState(0)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  const [hoverPreviewDismissed, setHoverPreviewDismissed] = useState(false)
  const [visibleProgressIndex, setVisibleProgressIndex] = useState(0)
  const visibleProgress = progressTrail[visibleProgressIndex] ?? progress
  const activeStage = stages.findIndex((stage) => stage.key === visibleProgress?.stage)
  const detailsVisible = detailsOpen || (isHovered && !hoverPreviewDismissed)

  useEffect(() => {
    if (visibleProgressIndex >= progressTrail.length - 1) return
    const timer = window.setTimeout(() => {
      setVisibleProgressIndex((current) => Math.min(current + 1, progressTrail.length - 1))
    }, STAGE_VISIBILITY_MS)
    return () => window.clearTimeout(timer)
  }, [progressTrail.length, visibleProgressIndex])

  useEffect(() => {
    const startedAt = Date.now()
    const updateElapsed = () => setElapsedMs(Date.now() - startedAt)
    updateElapsed()
    const timer = window.setInterval(updateElapsed, 1_000)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <article className="message-bubble message-assistant message-pending">
      <div className="message-role">助手</div>
      <div
        className={`thinking-card${detailsVisible ? ' is-visible' : ''}${detailsOpen ? ' is-expanded' : ''}`}
        role="status"
        aria-live="polite"
        aria-label="正在整理答案"
        onMouseEnter={() => {
          setIsHovered(true)
          setHoverPreviewDismissed(false)
        }}
        onMouseLeave={() => {
          setIsHovered(false)
          setHoverPreviewDismissed(false)
        }}
      >
        <div className="thinking-compact">
          <ol className="thinking-steps" aria-label="回答处理进度">
            {stages.map((stage, index) => {
              const Icon = stage.icon
              const complete = index < activeStage
              const current = index === activeStage
              return (
                <li key={stage.label} className={`thinking-step${complete ? ' is-complete' : ''}${current ? ' is-current' : ''}`}>
                  <span className="thinking-step-marker" aria-hidden="true">
                    {complete ? <Check size={12} /> : <Icon size={13} />}
                  </span>
                  <span>{stage.label}</span>
                </li>
              )
            })}
          </ol>
          <span className="thinking-elapsed"><Clock3 size={13} aria-hidden="true" />{formatElapsed(elapsedMs)}</span>
          <button
            type="button"
            className="thinking-toggle"
            aria-expanded={detailsOpen}
            aria-label={detailsOpen ? '收起处理详情' : '查看处理详情'}
            title={detailsOpen ? '收起处理详情' : '查看处理详情'}
            onClick={() => {
              setDetailsOpen((current) => {
                if (current) setHoverPreviewDismissed(true)
                else setHoverPreviewDismissed(false)
                return !current
              })
            }}
          >
            <span>详情</span>
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        </div>
        <div className="thinking-detail" aria-hidden={!detailsOpen}>
          <p className="thinking-detail-status">
            {visibleProgress?.message ?? '正在连接知识服务'}
          </p>
          <p className="thinking-hint">
            {elapsedMs >= 12_000
              ? '资料较多，我还在逐条核对来源。这个过程可能需要一点时间。'
              : '我会优先返回有正式资料支持、并附上出处的答案。'}
          </p>
        </div>
      </div>
    </article>
  )
}
