import { MessageCircle, Send, Share2, X } from 'lucide-react'

import type { ProductMaterial } from '../../../shared/api/product.js'
import type { MaterialShareChannel } from '../../../shared/api/materials.js'

interface MaterialDistributionDialogProps {
  material?: ProductMaterial
  busy?: boolean
  feedback?: string
  onSelectChannel: (channel: MaterialShareChannel) => void
  onClose: () => void
}

const channels: Array<{ id: MaterialShareChannel; label: string; description: string; className: string; icon: typeof MessageCircle; available: boolean }> = [
  { id: 'WECHAT', label: '微信', description: '手机端系统分享；电脑端下载后打开微信', className: 'material-channel-wechat', icon: MessageCircle, available: true },
  { id: 'FEISHU', label: '飞书', description: '打开手机系统分享面板', className: 'material-channel-feishu', icon: Send, available: true },
  { id: 'DINGTALK', label: '钉钉', description: '当前版本暂未接入', className: 'material-channel-dingtalk', icon: Share2, available: false },
]

export function MaterialDistributionDialog({
  material,
  busy = false,
  feedback,
  onSelectChannel,
  onClose,
}: MaterialDistributionDialogProps) {
  if (!material) return null

  return (
    <div className="material-modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose()
    }}>
      <section
        className="material-distribution-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="material-distribution-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) {
            event.preventDefault()
            onClose()
          }
        }}
      >
        <header className="material-distribution-heading">
          <div>
            <span className="material-distribution-kicker">资料分发</span>
            <h2 id="material-distribution-title">选择发送到的应用</h2>
          </div>
          <button type="button" className="icon-button" aria-label="关闭分发面板" title="关闭分发面板" disabled={busy} onClick={onClose}>
            <X aria-hidden="true" size={17} />
          </button>
        </header>
        <div className="material-distribution-file">
          <FileIcon />
          <span title={material.fileName}>{material.fileName}</span>
        </div>
        <p className="material-distribution-copy">手机端会优先唤起系统分享面板，由你确认联系人后发送；选择微信时，电脑端会先下载文件并尝试打开微信。</p>
        <div className="material-channel-grid" aria-label="分发渠道">
          {channels.map((channel) => {
            const Icon = channel.icon
            return (
              <button
                type="button"
                key={channel.id}
                className={`material-channel-button ${channel.className}${channel.available ? '' : ' is-disabled'}`}
                disabled={busy || !channel.available}
                onClick={() => onSelectChannel(channel.id)}
              >
                <span className="material-channel-icon"><Icon aria-hidden="true" size={16} /></span>
                <span>
                  <strong>{channel.label}</strong>
                  <small>{channel.description}</small>
                </span>
                {channel.available ? <span className="material-channel-action">选择</span> : null}
              </button>
            )
          })}
        </div>
        {busy ? <p className="material-distribution-feedback" role="status"><span className="spinner" />正在准备资料…</p> : null}
        {feedback ? <p className="material-distribution-feedback" role="status">{feedback}</p> : null}
        <p className="material-distribution-note">分发不会生成公开链接，也不会绕过飞书原有权限。</p>
      </section>
    </div>
  )
}

function FileIcon() {
  return <span className="material-distribution-file-icon" aria-hidden="true"><Share2 size={15} /></span>
}
