import { useMemo, useState } from 'react'

import type { ProductMessage } from '../../../shared/api/product.js'
import { groupMessagePairs, messagePairAnchorId, truncatePreview } from './messagePairs.js'

interface ConversationOutlineProps {
  messages: ProductMessage[]
  activePairId?: string
  onActivate: (pairId: string) => void
  onHighlight: (pairId?: string) => void
}

const MINIMUM_PAIRS = 3

export function ConversationOutline({
  messages,
  activePairId,
  onActivate,
  onHighlight,
}: ConversationOutlineProps) {
  const pairs = useMemo(() => groupMessagePairs(messages), [messages])
  const [hoveredPairId, setHoveredPairId] = useState<string>()

  if (pairs.length < MINIMUM_PAIRS) return null

  const effectiveActivePairId = pairs.some((pair) => pair.id === activePairId)
    ? activePairId
    : pairs[0]?.id

  function handleHover(pairId?: string) {
    setHoveredPairId(pairId)
    onHighlight(pairId)
  }

  return (
    <aside className="conversation-outline" aria-label="对话导航">
      <div className="conversation-outline-track">
        {pairs.map((pair, index) => {
          const isActive = pair.id === effectiveActivePairId
          const isHovered = pair.id === hoveredPairId
          const question = truncatePreview(pair.user?.content, 72)
          const answer = truncatePreview(pair.assistant?.content, 92)
          return (
            <div
              className={`conversation-outline-marker-wrap${isActive ? ' is-active' : ''}${isHovered ? ' is-hovered' : ''}`}
              key={pair.id}
              onMouseEnter={() => handleHover(pair.id)}
              onMouseLeave={() => handleHover(undefined)}
            >
              <button
                type="button"
                className="conversation-outline-marker"
                aria-label={`定位到第 ${index + 1} 组问答${question ? `：${question}` : ''}`}
                aria-controls={messagePairAnchorId(pair.id)}
                aria-current={isActive ? 'location' : undefined}
                onClick={() => onActivate(pair.id)}
              >
                <span aria-hidden="true" />
              </button>
              {isHovered ? (
                <div className="conversation-outline-preview" role="tooltip">
                  <span className="conversation-outline-index">第 {index + 1} 组问答</span>
                  {question ? <p><b>问</b>{question}</p> : null}
                  {answer ? <p><b>答</b>{answer}</p> : <p className="conversation-outline-empty">回答生成中</p>}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </aside>
  )
}
