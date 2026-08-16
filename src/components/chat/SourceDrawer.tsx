import { ExternalLink, X } from 'lucide-react'
import { useEffect, useRef } from 'react'

import type { ProductCitation } from '../../../shared/api/product.js'

interface SourceDrawerProps {
  citation?: ProductCitation
  modal: boolean
  onClose: () => void
}

export function SourceDrawer({ citation, modal, onClose }: SourceDrawerProps) {
  const drawerRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const previousModalRef = useRef(modal)

  useEffect(() => {
    if (citation) closeRef.current?.focus()
  }, [citation])

  useEffect(() => {
    const becameModal = modal && !previousModalRef.current
    previousModalRef.current = modal
    if (citation && becameModal) closeRef.current?.focus()
  }, [citation, modal])

  if (!citation) return null

  return (
    <aside
      ref={drawerRef}
      id="source-drawer"
      className="source-drawer"
      role="dialog"
      aria-modal={modal ? 'true' : undefined}
      aria-label="来源详情"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
          return
        }
        if (!modal || event.key !== 'Tab') return
        const focusable = Array.from(drawerRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [])
        const first = focusable[0]
        const last = focusable.at(-1)
        if (!first || !last) return
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }}
    >
      <div className="drawer-heading">
        <h2>来源详情</h2>
        <button ref={closeRef} type="button" className="icon-button" aria-label="关闭来源" title="关闭来源" onClick={onClose}>
          <X aria-hidden="true" size={18} />
        </button>
      </div>
      <div className="source-drawer-content">
        <h3>{citation.title}</h3>
        {citation.path ? <p className="source-path">{citation.path}</p> : null}
        <p className="source-line">{citation.locator}</p>
        <p>{citation.excerpt}</p>
        <a
          className="secondary-button"
          href={`/api/citations/${citation.id}/open`}
          target="_blank"
          rel="noreferrer"
        >
          <ExternalLink aria-hidden="true" size={16} />
          打开飞书原文
        </a>
      </div>
    </aside>
  )
}
