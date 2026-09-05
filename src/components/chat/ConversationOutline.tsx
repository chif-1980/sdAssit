import { useEffect, useMemo, useRef, useState } from 'react'

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
  const activeMarkerRef = useRef<HTMLButtonElement | null>(null)
  const markerRefs = useRef(new Map<string, HTMLButtonElement>())
  const outlineScrollRef = useRef<HTMLDivElement>(null)
  const [hoveredPreviewTop, setHoveredPreviewTop] = useState<number>()

  const effectiveActivePairId = pairs.some((pair) => pair.id === activePairId)
    ? activePairId
    : pairs[0]?.id

  useEffect(() => {
    const marker = activeMarkerRef.current
    if (typeof marker?.scrollIntoView === 'function') marker.scrollIntoView({ block: 'nearest' })
  }, [effectiveActivePairId])

  if (pairs.length < MINIMUM_PAIRS) return null

  function handleHover(pairId?: string) {
    setHoveredPairId(pairId)
    onHighlight(pairId)
    if (!pairId) {
      setHoveredPreviewTop(undefined)
      return
    }
    const marker = markerRefs.current.get(pairId)
    const scrollContainer = outlineScrollRef.current
    if (marker && scrollContainer) {
      setHoveredPreviewTop(marker.offsetTop - scrollContainer.scrollTop + marker.offsetHeight / 2)
    }
  }

  function handleOutlineScroll() {
    if (!hoveredPairId) return
    const marker = markerRefs.current.get(hoveredPairId)
    const scrollContainer = outlineScrollRef.current
    if (marker && scrollContainer) {
      setHoveredPreviewTop(marker.offsetTop - scrollContainer.scrollTop + marker.offsetHeight / 2)
    }
  }

  const activePairIndex = effectiveActivePairId
    ? pairs.findIndex((pair) => pair.id === effectiveActivePairId)
    : -1
  const hoveredPairIndex = hoveredPairId ? pairs.findIndex((pair) => pair.id === hoveredPairId) : -1
  const hoveredPair = hoveredPairIndex >= 0 ? pairs[hoveredPairIndex] : undefined

  return (
    <aside className="conversation-outline" aria-label="对话导航">
      <div className="conversation-outline-count" aria-live="polite">
        {activePairIndex >= 0 ? `第 ${activePairIndex + 1} / ${pairs.length} 组问答` : `共 ${pairs.length} 组问答`}
      </div>
      <div ref={outlineScrollRef} className="conversation-outline-scroll" onScroll={handleOutlineScroll}>
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
                  ref={(element) => {
                    if (element) markerRefs.current.set(pair.id, element)
                    else markerRefs.current.delete(pair.id)
                    if (isActive) activeMarkerRef.current = element
                  }}
                  type="button"
                  className="conversation-outline-marker"
                  aria-label={`定位到第 ${index + 1} 组问答${question ? `：${question}` : ''}`}
                  aria-controls={messagePairAnchorId(pair.id)}
                  aria-current={isActive ? 'location' : undefined}
                  onClick={() => onActivate(pair.id)}
                >
                  <span aria-hidden="true" />
                </button>
              </div>
            )
          })}
        </div>
      </div>
      {hoveredPair ? (
        <div
          className={`conversation-outline-preview${hoveredPairIndex === 0 ? ' is-first' : ''}${hoveredPairIndex === pairs.length - 1 ? ' is-last' : ''}`}
          role="tooltip"
          style={hoveredPreviewTop === undefined ? undefined : { top: hoveredPreviewTop }}
        >
          <span className="conversation-outline-index">第 {hoveredPairIndex + 1} 组问答</span>
          {hoveredPair.user?.content ? <p><b>问</b>{truncatePreview(hoveredPair.user.content, 72)}</p> : null}
          {hoveredPair.assistant?.content ? <p><b>答</b>{truncatePreview(hoveredPair.assistant.content, 92)}</p> : <p className="conversation-outline-empty">回答生成中</p>}
        </div>
      ) : null}
    </aside>
  )
}
