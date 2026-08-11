import { AlertTriangle, Inbox, LockKeyhole, RefreshCw } from 'lucide-react'

export type AsyncStatus = 'loading' | 'ready' | 'empty' | 'error' | 'forbidden'

interface AsyncStateProps {
  status: AsyncStatus
  emptyTitle?: string
  errorTitle?: string
  onRetry?: () => void
  children: React.ReactNode
}

export function AsyncState({ status, emptyTitle = '暂无内容', errorTitle = '加载失败', onRetry, children }: AsyncStateProps) {
  if (status === 'ready') return <>{children}</>

  if (status === 'loading') {
    return (
      <div className="async-state loading-state" aria-label="正在加载">
        <span /><span /><span />
      </div>
    )
  }

  if (status === 'forbidden') {
    return (
      <div className="async-state">
        <LockKeyhole aria-hidden="true" />
        <h2>无权查看此内容</h2>
      </div>
    )
  }

  if (status === 'empty') {
    return (
      <div className="async-state">
        <Inbox aria-hidden="true" />
        <h2>{emptyTitle}</h2>
      </div>
    )
  }

  return (
    <div className="async-state" role="alert">
      <AlertTriangle aria-hidden="true" />
      <h2>{errorTitle}</h2>
      {onRetry ? (
        <button type="button" className="secondary-button" onClick={onRetry}>
          <RefreshCw aria-hidden="true" size={16} />
          重新加载
        </button>
      ) : null}
    </div>
  )
}
