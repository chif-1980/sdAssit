import { ExternalLink, X } from 'lucide-react'

import type { Citation } from '../../../shared/domain/models.js'

interface SourceDrawerProps {
  citation?: Citation
  canViewAsset?: boolean
  onClose: () => void
}

export function SourceDrawer({ citation, canViewAsset = false, onClose }: SourceDrawerProps) {
  if (!citation) return null

  return (
    <aside className="source-drawer" role="dialog" aria-modal="true" aria-label="来源详情">
      <div className="drawer-heading">
        <h2>来源详情</h2>
        <button type="button" className="icon-button" aria-label="关闭来源" onClick={onClose}>
          <X aria-hidden="true" size={18} />
        </button>
      </div>
      <div className="source-drawer-content">
        <h3>{citation.title}</h3>
        <p className="source-line">位置：{citation.locator}</p>
        <p>{citation.excerpt}</p>
        {canViewAsset ? (
          <a className="secondary-button" href={`/factory/assets/${citation.assetId}`}>
            <ExternalLink aria-hidden="true" size={16} />
            查看资料
          </a>
        ) : null}
      </div>
    </aside>
  )
}
