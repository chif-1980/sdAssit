import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

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
  const previewRef = useRef<HTMLDivElement>(null)
  const previewId = useId()
  const [previewPosition, setPreviewPosition] = useState<{ top: number; left: number }>()

  const effectiveActivePairId = pairs.some((pair) => pair.id === activePairId)
    ? activePairId
    : pairs[0]?.id

  useEffect(() => {
    const marker = activeMarkerRef.current
    if (typeof marker?.scrollIntoView === 'function') marker.scrollIntoView({ block: 'nearest' })
  }, [effectiveActivePairId])

  useLayoutEffect(() => {
    if (!hoveredPairId) return
    function positionPreview() {
      const marker = markerRefs.current.get(hoveredPairId!)
      const preview = previewRef.current
      const rail = outlineScrollRef.current
      if (!marker || !preview || !rail) return
      const anchor = marker.getBoundingClientRect()
      const bounds = rail.getBoundingClientRect()
      const minTop = Math.max(12, Math.min(bounds.top, window.innerHeight - preview.offsetHeight - 12))
      const maxTop = Math.max(minTop, Math.min(window.innerHeight - 12, bounds.bottom) - preview.offsetHeight)
      setPreviewPosition({
        top: Math.min(maxTop, Math.max(minTop, anchor.top + anchor.height / 2 - preview.offsetHeight / 2)),
        left: Math.max(12, Math.min(anchor.right + 10, window.innerWidth - preview.offsetWidth - 12)),
      })
    }
    positionPreview()
    window.addEventListener('resize', positionPreview)
    window.addEventListener('scroll', positionPreview, true)
    return () => {
      window.removeEventListener('resize', positionPreview)
      window.removeEventListener('scroll', positionPreview, true)
    }
  }, [hoveredPairId, pairs])

  if (pairs.length < MINIMUM_PAIRS) return null

  function handleHover(pairId?: string) {
    setHoveredPairId(pairId)
    onHighlight(pairId)
    if (!pairId) setPreviewPosition(undefined)
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
      <div ref={outlineScrollRef} className="conversation-outline-scroll" onScroll={() => handleHover(undefined)}>
        <div className="conversation-outline-track">
          {pairs.map((pair, index) => {
            const isActive = pair.id === effectiveActivePairId
            const isHovered = pair.id === hoveredPairId
            const question = truncatePreview(pair.user?.content, 72)
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
                  aria-describedby={isHovered ? previewId : undefined}
                  onFocus={() => handleHover(pair.id)}
                  onBlur={() => handleHover(undefined)}
                  onKeyDown={event => { if (event.key === 'Escape') handleHover(undefined) }}
                  onClick={() => onActivate(pair.id)}
                >
                  <span aria-hidden="true" />
                </button>
              </div>
            )
          })}
        </div>
      </div>
      {hoveredPair ? createPortal(
        <div
          ref={previewRef}
          id={previewId}
          className="conversation-outline-preview"
          role="tooltip"
          style={{ ...previewPosition, visibility: previewPosition ? 'visible' : 'hidden' }}
        >
          <div className="conversation-outline-preview-heading"><span className="conversation-outline-index">第 {hoveredPairIndex + 1} 组问答</span><span>点击圆点定位</span></div>
          {hoveredPair.user?.content ? <p className="conversation-outline-question"><b>问</b><span>{truncatePreview(hoveredPair.user.content, 100)}</span></p> : null}
          {hoveredPair.assistant?.content ? <p className="conversation-outline-answer"><b>答</b><span>{truncatePreview(hoveredPair.assistant.content, 160)}</span></p> : <p className="conversation-outline-empty">回答生成中</p>}
        </div>, document.body,
      ) : null}
    </aside>
  )
}
