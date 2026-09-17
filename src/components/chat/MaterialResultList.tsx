import { BookOpen, CheckCircle2, Clock3, Download, ExternalLink, FileText, Share2 } from 'lucide-react'

import type { ProductMaterial } from '../../../shared/api/product.js'

interface MaterialResultListProps {
  materials: ProductMaterial[]
  onPreview: (material: ProductMaterial, trigger: HTMLButtonElement) => void
  onDownload: (material: ProductMaterial) => void
  onDistribute: (material: ProductMaterial) => void
}

function materialIcon(type: string) {
  return type === '解决方案' ? <BookOpen aria-hidden="true" size={18} /> : <FileText aria-hidden="true" size={18} />
}

function formatUpdatedAt(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return undefined
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

export function MaterialResultList({
  materials,
  onPreview,
  onDownload,
  onDistribute,
}: MaterialResultListProps) {
  if (!materials.length) return null

  return (
    <section className="material-result-list" aria-label="资料检索结果">
      <div className="material-result-heading">
        <div>
          <strong>相关资料</strong>
          <span>仅展示已审核、已发布并完成索引的飞书资料</span>
        </div>
        <span className="material-result-count">{materials.length} 份</span>
      </div>
      <div className="material-result-cards">
        {materials.map((material) => {
          const size = formatBytes(material.sizeBytes)
          return (
            <article className="material-result-card" key={material.id}>
              <div className="material-result-icon" aria-hidden="true">{materialIcon(material.type)}</div>
              <div className="material-result-main">
                <div className="material-result-title-row">
                  <span className="material-result-type">{material.type}</span>
                  <span className="material-result-status"><CheckCircle2 aria-hidden="true" size={12} />已审核 · 已发布</span>
                </div>
                <h3>{material.title}</h3>
                <p>{material.summary || '暂无摘要，可打开来源查看完整内容。'}</p>
                <div className="material-result-meta">
                  <span><Clock3 aria-hidden="true" size={12} />更新于 {formatUpdatedAt(material.updatedAt)}</span>
                  {size ? <span>{size}</span> : null}
                  <span>飞书知识库</span>
                </div>
                <div className="material-result-actions">
                  <button type="button" className="material-result-button" onClick={(event) => onPreview(material, event.currentTarget)}>
                    查看摘要
                  </button>
                  <a
                    className="material-result-button"
                    href={`/api/citations/${encodeURIComponent(material.citation.id)}/open`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <ExternalLink aria-hidden="true" size={13} />打开飞书原文
                  </a>
                  <button type="button" className="material-result-button" onClick={() => onDownload(material)}>
                    <Download aria-hidden="true" size={13} />下载
                  </button>
                  <button type="button" className="material-result-button" onClick={() => onDistribute(material)}>
                    <Share2 aria-hidden="true" size={13} />分发
                  </button>
                </div>
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
