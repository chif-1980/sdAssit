import { Children, isValidElement, useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Components } from 'react-markdown'

type MermaidRenderResult = {
  svg: string
  bindFunctions?: (element: HTMLElement) => void
}

type MermaidRenderer = {
  initialize: (config: Record<string, unknown>) => void
  render: (id: string, definition: string) => Promise<MermaidRenderResult>
}

type RenderState = 'loading' | 'ready' | 'error'

let mermaidPromise: Promise<MermaidRenderer> | undefined

function loadMermaid() {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Mermaid 只能在浏览器中渲染。'))
  }
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        themeVariables: {
          primaryColor: '#eaf2ff',
          primaryBorderColor: '#8fb0df',
          primaryTextColor: '#1d3557',
          lineColor: '#7a93b6',
          secondaryColor: '#f6f9fd',
          tertiaryColor: '#f8fbff',
          fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          fontSize: '13px',
        },
      })
      return mermaid as unknown as MermaidRenderer
    })
  }
  return mermaidPromise
}

function MermaidCode({ code }: { code: string }) {
  return (
    <pre className="mermaid-code">
      <code>{code}</code>
    </pre>
  )
}

export function MermaidBlock({ code }: { code: string }) {
  const diagramId = `mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const diagramRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<'diagram' | 'code'>('diagram')
  const [renderState, setRenderState] = useState<RenderState>('loading')
  const [rendered, setRendered] = useState<MermaidRenderResult>()

  useEffect(() => {
    let cancelled = false
    setRenderState('loading')
    setRendered(undefined)

    void loadMermaid()
      .then((renderer) => renderer.render(diagramId, code))
      .then((result) => {
        if (cancelled) return
        setRendered(result)
        setRenderState('ready')
      })
      .catch(() => {
        if (cancelled) return
        setRenderState('error')
      })

    return () => {
      cancelled = true
    }
  }, [code, diagramId])

  useEffect(() => {
    if (renderState !== 'ready' || !rendered || !diagramRef.current) return
    rendered.bindFunctions?.(diagramRef.current)
  }, [renderState, rendered])

  return (
    <section className="mermaid-block" data-mermaid-block aria-label="Mermaid 图形">
      <header className="mermaid-block-header">
        <div className="mermaid-block-title">
          <span className="mermaid-block-kicker">图形</span>
          <strong>Mermaid</strong>
        </div>
        <div className="mermaid-block-tabs" role="group" aria-label="Mermaid 查看方式">
          <button
            type="button"
            className={view === 'diagram' ? 'is-active' : ''}
            aria-label="查看图形"
            aria-pressed={view === 'diagram'}
            onClick={() => setView('diagram')}
          >
            图形
          </button>
          <button
            type="button"
            className={view === 'code' ? 'is-active' : ''}
            aria-label="查看代码"
            aria-pressed={view === 'code'}
            onClick={() => setView('code')}
          >
            代码
          </button>
        </div>
      </header>
      {view === 'code' ? <MermaidCode code={code} /> : (
        <div className="mermaid-block-body">
          {renderState === 'loading' ? (
            <p className="mermaid-block-status" role="status">正在绘制图形…</p>
          ) : null}
          {renderState === 'error' ? (
            <div className="mermaid-block-error" role="alert">
              <strong>无法绘制此图形</strong>
              <span>这段 Mermaid 语法可能不完整，已保留代码供查看。</span>
              <MermaidCode code={code} />
            </div>
          ) : null}
          {renderState === 'ready' && rendered ? (
            <div
              ref={diagramRef}
              className="mermaid-diagram"
              role="img"
              aria-label="Mermaid 图形预览"
              dangerouslySetInnerHTML={{ __html: rendered.svg }}
            />
          ) : null}
        </div>
      )}
    </section>
  )
}

function isMermaidBlock(node: ReactNode) {
  if (!isValidElement(node)) return false
  if (node.type === MermaidBlock) return true
  return (node.props as { 'data-mermaid-block'?: boolean | string })['data-mermaid-block'] === true
    || (node.props as { 'data-mermaid-block'?: boolean | string })['data-mermaid-block'] === 'true'
}

/** Markdown overrides that turn fenced `mermaid` blocks into safe, toggleable previews. */
export const mermaidMarkdownComponents: Components = {
  code({ className, children, node: _node, ...props }) {
    const language = /(?:^|\s)language-([\w-]+)/i.exec(className ?? '')?.[1]
    if (language?.toLowerCase() === 'mermaid') {
      return <MermaidBlock code={String(children ?? '').replace(/\n$/, '')} />
    }
    return <code className={className} {...props}>{children}</code>
  },
  pre({ children, node: _node, ...props }) {
    const child = Children.toArray(children).find(isMermaidBlock)
    if (child) return child
    return <pre {...props}>{children}</pre>
  },
}
