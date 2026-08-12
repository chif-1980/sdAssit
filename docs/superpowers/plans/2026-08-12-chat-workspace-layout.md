# 知识问答工作区布局改版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将知识问答页面改为浅蓝色全高工作区，使消息区域独立滚动、输入区固定在底部，并在手机端提供会话抽屉。

**Architecture:** 由 `ProductShell` 为 `/chat` 提供专用全高模式，`ChatPage` 统一渲染会话栏、消息区和输入区，不再为新对话使用独立居中布局。滚动职责收敛到会话列表和消息区域，来源栏及手机会话栏使用覆盖式抽屉；数据请求和业务状态逻辑保持不变。

**Tech Stack:** React 18、TypeScript、React Router、Lucide React、CSS Grid、Vitest、Testing Library。

---

## 文件结构

- `src/components/layout/ProductShell.tsx`：识别聊天路由并提供全高页面模式。
- `src/app/App.test.tsx`：验证聊天路由使用专用外壳，同时保持唯一一级标题。
- `src/pages/ChatPage.tsx`：统一聊天工作区结构，管理手机会话抽屉状态。
- `src/pages/ChatPage.test.tsx`：验证底部输入区、消息滚动区和会话抽屉交互。
- `src/components/chat/MessageThread.tsx`：消息变化后将视图移动到最新消息。
- `src/components/chat/MessageThread.test.tsx`：验证首次加载和追加消息时的自动滚动。
- `src/styles/app.css`：实现全高网格、浅蓝主题、透明结构分割线及响应式抽屉。

### Task 1: 为聊天路由提供全高产品外壳

**Files:**
- Modify: `src/app/App.test.tsx`
- Modify: `src/components/layout/ProductShell.tsx`
- Modify: `src/styles/app.css`

- [ ] **Step 1: 写入失败测试**

在 `src/app/App.test.tsx` 的聊天路由用例中加入外壳断言：

```tsx
it('sends an Employee from the root to Knowledge AI without factory navigation', async () => {
  renderAt('/', 'EMPLOYEE')

  expect(await screen.findByRole('heading', { level: 1, name: '知识问答' })).toBeInTheDocument()
  expect(document.querySelector('.product-shell')).toHaveClass('chat-mode')
  expect(screen.queryByText('Knowledge Factory')).not.toBeInTheDocument()
  expect(window.location.pathname).toBe('/chat')
})
```

- [ ] **Step 2: 运行测试并确认红灯**

Run: `npm run test:run -- src/app/App.test.tsx`

Expected: FAIL，`.product-shell` 尚未包含 `chat-mode`。

- [ ] **Step 3: 最小实现聊天路由模式**

在 `src/components/layout/ProductShell.tsx` 中增加聊天路由判断，并替换外层类名：

```tsx
const inFactory = location.pathname.startsWith('/factory')
const inChat = location.pathname === '/chat'
const shellClassName = inFactory
  ? 'product-shell factory-mode'
  : inChat
    ? 'product-shell chat-mode'
    : 'product-shell'

return (
  <div className={shellClassName}>
```

在 `src/styles/app.css` 中加入全高约束，结构分割线保持透明：

```css
.product-shell.chat-mode {
  height: 100dvh;
  min-height: 0;
  overflow: hidden;
}

.product-shell.chat-mode .topbar { border-bottom-color: transparent; }
.product-shell.chat-mode .page-content {
  min-height: 0;
  padding: 0;
  overflow: hidden;
}
```

- [ ] **Step 4: 运行测试并确认绿灯**

Run: `npm run test:run -- src/app/App.test.tsx`

Expected: 该文件全部测试通过。

- [ ] **Step 5: 提交**

```bash
git add src/app/App.test.tsx src/components/layout/ProductShell.tsx src/styles/app.css
git commit -m "feat: add full-height chat shell"
```

### Task 2: 统一工作区结构并增加手机会话抽屉

**Files:**
- Modify: `src/pages/ChatPage.test.tsx`
- Modify: `src/pages/ChatPage.tsx`

- [ ] **Step 1: 将新对话测试改为固定工作区预期**

用以下测试替换“居中输入框”用例：

```tsx
it('keeps the workspace and bottom composer visible for a new conversation', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ conversations: [] })))

  renderPage()

  expect(await screen.findByRole('heading', { level: 1, name: '知识问答' })).toBeInTheDocument()
  expect(screen.getByLabelText('会话历史')).toBeInTheDocument()
  expect(screen.getByLabelText('消息滚动区域')).toBeInTheDocument()
  expect(screen.getByLabelText('底部输入区')).toContainElement(screen.getByPlaceholderText('输入你的问题'))
  expect(screen.getByText('从一个问题开始')).toBeInTheDocument()
})
```

再加入手机抽屉状态测试：

```tsx
it('opens and closes the mobile conversation drawer', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ conversations: [] })))

  renderPage()
  const openButton = await screen.findByRole('button', { name: '打开会话列表' })
  expect(openButton).toHaveAttribute('aria-expanded', 'false')

  await userEvent.click(openButton)
  expect(openButton).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByLabelText('会话历史')).toHaveClass('mobile-open')

  await userEvent.click(screen.getByRole('button', { name: '关闭会话列表' }))
  expect(openButton).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByLabelText('会话历史')).not.toHaveClass('mobile-open')
})
```

- [ ] **Step 2: 运行测试并确认红灯**

Run: `npm run test:run -- src/pages/ChatPage.test.tsx`

Expected: FAIL，新对话尚未渲染会话栏和语义区域，也没有抽屉按钮。

- [ ] **Step 3: 增加抽屉状态并统一页面结构**

在 `src/pages/ChatPage.tsx` 中引入图标并增加状态：

```tsx
import { AlertTriangle, Archive, PanelLeft, Plus, RefreshCw, X } from 'lucide-react'

const [conversationListOpen, setConversationListOpen] = useState(false)
```

在 `selectConversation` 和 `startConversation` 成功进入目标视图时执行：

```tsx
setConversationListOpen(false)
```

用统一工作区替换当前 `conversation ? ... : chat-start` 两套分支。加载、错误和无权限仍由 `AsyncState` 处理；其余状态使用以下结构：

```tsx
<div className={selectedCitation ? 'chat-layout source-open' : 'chat-layout'}>
  <button
    type="button"
    className={conversationListOpen ? 'conversation-backdrop is-open' : 'conversation-backdrop'}
    aria-label="关闭会话列表遮罩"
    onClick={() => setConversationListOpen(false)}
  />
  <aside
    id="conversation-sidebar"
    className={conversationListOpen ? 'conversation-sidebar mobile-open' : 'conversation-sidebar'}
    aria-label="会话历史"
  >
    <div className="sidebar-product-title">
      <div><h1>知识问答</h1><p>企业知识助手</p></div>
      <button type="button" className="icon-button conversation-sidebar-close" aria-label="关闭会话列表" onClick={() => setConversationListOpen(false)}><X aria-hidden="true" size={17} /></button>
    </div>
    <div className="sidebar-heading">
      <h2>会话</h2>
      <button type="button" className="icon-button" aria-label="新对话" disabled={navigationLocked} onClick={startConversation}><Plus aria-hidden="true" size={17} /></button>
    </div>
    {visibleConversations.length ? (
      <ul>{visibleConversations.map((item) => <li key={item.id}><button type="button" disabled={navigationLocked} className={item.id === activeConversationId ? 'conversation-link active' : 'conversation-link'} onClick={() => void selectConversation(item)}>{item.title}</button></li>)}</ul>
    ) : <p className="inline-empty">暂无历史会话</p>}
  </aside>

  <section className="chat-main" aria-label="对话工作区">
    <header className="chat-conversation-header">
      <div className="chat-conversation-title">
        <button
          type="button"
          className="icon-button conversation-drawer-trigger"
          aria-label="打开会话列表"
          aria-controls="conversation-sidebar"
          aria-expanded={conversationListOpen}
          onClick={() => setConversationListOpen(true)}
        ><PanelLeft aria-hidden="true" size={17} /></button>
        <strong>{conversation?.title ?? '新对话'}</strong>
      </div>
      {conversation?.status === 'ACTIVE' ? <button type="button" className="secondary-button" disabled={navigationLocked} onClick={() => void archiveConversation()}><Archive aria-hidden="true" size={16} />归档会话</button> : null}
      {conversation?.status === 'ARCHIVED' ? <span className="status-chip">已归档</span> : null}
    </header>

    <div className="chat-message-scroll" aria-label="消息滚动区域">
      {messages.length ? <MessageThread messages={messages} onCitation={setSelectedCitation} /> : (
        <div className="chat-empty"><Archive aria-hidden="true" size={28} /><h2>从一个问题开始</h2><p>提问后，回答会显示在这里，并附带可核验来源。</p></div>
      )}
      {status === 'ready' && conversation?.status === 'ARCHIVED' ? <p className="inline-empty">此会话已归档。</p> : null}
      {status === 'ready' && conversation && sending ? <p className="chat-loading"><RefreshCw aria-hidden="true" size={14} />正在生成回答</p> : null}
    </div>

    {promotePanel}
    <div className="chat-composer-dock" aria-label="底部输入区">{composer}</div>
  </section>
  <SourceDrawer citation={selectedCitation} canViewAsset={canViewFactoryAsset} onClose={() => setSelectedCitation(undefined)} />
</div>
```

移除旧的 `.chat-page-heading`、`.chat-start` 分支和布局外部的归档/生成状态行。`errorText` 保持在工作区之前，并通过 Task 4 的定位规则覆盖显示。

- [ ] **Step 4: 运行定向测试并修正回归**

Run: `npm run test:run -- src/pages/ChatPage.test.tsx`

Expected: `ChatPage.test.tsx` 全部测试通过，包括发送、上传、切换、提升和归档锁定。

- [ ] **Step 5: 提交**

```bash
git add src/pages/ChatPage.tsx src/pages/ChatPage.test.tsx
git commit -m "feat: restructure chat workspace"
```

### Task 3: 消息追加后自动滚动到最新内容

**Files:**
- Create: `src/components/chat/MessageThread.test.tsx`
- Modify: `src/components/chat/MessageThread.tsx`

- [ ] **Step 1: 写入失败测试**

创建 `src/components/chat/MessageThread.test.tsx`：

```tsx
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ConversationMessage } from '../../../shared/domain/models.js'
import { MessageThread } from './MessageThread'

const firstMessage: ConversationMessage = {
  id: 'MSG-1', conversationId: 'CVS-1', role: 'USER', text: '第一个问题', citations: [], createdAt: '2026-08-12T00:00:00.000Z',
}

afterEach(() => {
  cleanup()
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
})

describe('MessageThread', () => {
  it('scrolls the latest message into view after messages change', () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
    const { rerender } = render(<MessageThread messages={[firstMessage]} onCitation={vi.fn()} />)

    scrollIntoView.mockClear()
    rerender(<MessageThread messages={[firstMessage, { ...firstMessage, id: 'MSG-2', role: 'ASSISTANT', text: '最新回答' }]} onCitation={vi.fn()} />)

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'end' })
  })
})
```

- [ ] **Step 2: 运行测试并确认红灯**

Run: `npm run test:run -- src/components/chat/MessageThread.test.tsx`

Expected: FAIL，尚未调用 `scrollIntoView`。

- [ ] **Step 3: 实现消息末尾锚点**

更新 `src/components/chat/MessageThread.tsx`：

```tsx
import { useEffect, useRef } from 'react'
import type { ConversationMessage } from '../../../shared/domain/models.js'

interface MessageThreadProps {
  messages: ConversationMessage[]
  onCitation: (citation: ConversationMessage['citations'][number]) => void
}

export function MessageThread({ messages, onCitation }: MessageThreadProps) {
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  return (
    <div className="message-thread" aria-label="消息线程">
      {messages.map((message) => (
        <article key={message.id} className={`message-bubble message-${message.role.toLowerCase()}`}>
          <div className="message-role">{message.role === 'USER' ? '你' : '知识问答'}</div>
          <p>{message.text}</p>
          {message.citations.length ? (
            <div className="message-citations" aria-label="回答引用">
              {message.citations.map((citation, index) => (
                <button type="button" className="citation-button" key={`${citation.knowledgeId}:${citation.assetId}:${citation.locator}`} aria-label={`[${index + 1}]`} onClick={() => onCitation(citation)}>[{index + 1}]</button>
              ))}
            </div>
          ) : null}
        </article>
      ))}
      <div ref={endRef} aria-hidden="true" />
    </div>
  )
}
```

- [ ] **Step 4: 运行测试并确认绿灯**

Run: `npm run test:run -- src/components/chat/MessageThread.test.tsx src/pages/ChatPage.test.tsx`

Expected: 两个文件全部测试通过。

- [ ] **Step 5: 提交**

```bash
git add src/components/chat/MessageThread.tsx src/components/chat/MessageThread.test.tsx
git commit -m "feat: keep latest chat message visible"
```

### Task 4: 实现浅蓝、无结构分割线的响应式样式

**Files:**
- Modify: `src/styles/app.css`

- [ ] **Step 1: 替换聊天页面核心布局样式**

删除旧 `.chat-page-heading`、`.chat-start`、`.chat-content` 和旧移动端会话栏规则，并按以下原则写入完整聊天样式：

```css
.chat-page {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: #f7f9fc;
  color: #1f2937;
}
.chat-page > .error-banner { position: absolute; z-index: 9; top: 12px; left: 50%; width: min(680px, calc(100% - 32px)); transform: translateX(-50%); }
.chat-layout { width: 100%; height: 100%; min-height: 0; display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 0; overflow: hidden; background: transparent; }
.chat-layout.source-open { grid-template-columns: 220px minmax(0, 1fr) 300px; }
.conversation-sidebar, .chat-main, .source-drawer { min-width: 0; min-height: 0; border: 0; }
.conversation-sidebar { display: grid; grid-template-rows: auto auto minmax(0, 1fr); padding: 18px 12px; overflow: hidden; background: #f4f7fb; }
.sidebar-product-title, .sidebar-heading, .chat-conversation-header, .chat-conversation-title, .drawer-heading { display: flex; align-items: center; }
.sidebar-product-title, .sidebar-heading, .chat-conversation-header, .drawer-heading { justify-content: space-between; gap: 10px; }
.sidebar-product-title { padding: 0 6px 22px; }
.sidebar-product-title h1 { margin: 0; font-size: 16px; }
.sidebar-product-title p { margin: 4px 0 0; color: #697586; font-size: 12px; }
.sidebar-heading { padding: 0 4px 10px; }
.sidebar-heading h2, .drawer-heading h2 { margin: 0; font-size: 13px; }
.conversation-sidebar ul { min-height: 0; display: grid; align-content: start; gap: 3px; margin: 0; padding: 0; overflow: auto; list-style: none; }
.conversation-link { width: 100%; overflow: hidden; padding: 10px; border: 0; border-radius: 7px; background: transparent; color: #697586; text-align: left; text-overflow: ellipsis; white-space: nowrap; }
.conversation-link:hover, .conversation-link.active { background: #eaf2ff; color: #1f2937; font-weight: 650; }
.chat-main { display: grid; grid-template-rows: 56px minmax(0, 1fr) auto auto; min-height: 0; padding: 0; background: #ffffff; }
.chat-conversation-header { padding: 0 24px; background: #ffffff; }
.chat-conversation-title { min-width: 0; gap: 10px; }
.chat-conversation-title strong { min-width: 0; overflow: hidden; font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
.chat-message-scroll { min-height: 0; overflow: auto; padding: 28px clamp(18px, 5vw, 56px) 22px; scrollbar-gutter: stable; }
.message-thread { width: min(820px, 100%); display: grid; align-content: start; gap: 24px; margin: 0 auto; padding: 0; overflow: visible; }
.message-bubble { max-width: 100%; padding: 0; border: 0; border-radius: 0; background: transparent; }
.message-user { max-width: min(76%, 680px); justify-self: end; padding: 10px 13px; border-radius: 8px; background: #eaf2ff; }
.message-assistant { justify-self: stretch; }
.message-role { margin-bottom: 7px; color: #697586; font-size: 11px; font-weight: 700; }
.message-assistant .message-role, .citation-button { color: #3b74d7; }
.message-bubble p { margin: 0; line-height: 1.75; white-space: pre-wrap; }
.message-citations { display: flex; gap: 6px; margin-top: 12px; }
.citation-button, .chat-page .icon-button { border-color: #dce3ec; background: #ffffff; color: #3b74d7; }
.chat-empty { min-height: 100%; display: grid; place-content: center; justify-items: center; gap: 10px; color: #697586; text-align: center; }
.chat-empty h2 { margin: 0; color: #1f2937; font-size: 18px; }
.chat-empty p { margin: 0; font-size: 13px; }
.chat-composer-dock { padding: 12px 24px 18px; background: #ffffff; }
.chat-composer { width: min(820px, 100%); display: grid; gap: 10px; margin: 0 auto; padding: 12px; border: 1px solid #dce3ec; border-radius: 8px; background: #ffffff; box-shadow: 0 8px 24px rgb(30 56 92 / 12%); }
.chat-composer textarea { width: 100%; min-height: 62px; padding: 2px; border: 0; outline: 0; resize: none; background: transparent; color: #1f2937; }
.chat-composer textarea:focus-visible { box-shadow: inset 0 -2px #3b74d7; }
.chat-page .primary-button { border-color: #3b74d7; background: #3b74d7; }
.chat-page .secondary-button { border-color: #dce3ec; color: #445064; }
.scope-control { color: #697586; }
.scope-control select { border-color: #dce3ec; color: #1f2937; }
.attachment-status { border-color: #dce3ec; background: #f7f9fc; color: #536174; }
.promote-panel { margin: 0 24px; border: 0; background: #eaf2ff; }
.promote-panel strong { color: #315fba; }
.promote-list { border-top-color: transparent; }
.source-drawer { padding: 18px; overflow: auto; background: #f4f7fb; }
.conversation-drawer-trigger, .conversation-sidebar-close, .conversation-backdrop { display: none; }
```

- [ ] **Step 2: 写入平板与手机规则**

```css
@media (max-width: 1024px) {
  .chat-layout, .chat-layout.source-open { grid-template-columns: 190px minmax(0, 1fr); }
  .source-drawer { position: fixed; inset: 56px 0 0 auto; z-index: 8; width: min(380px, 100%); border: 0; box-shadow: -12px 0 28px rgb(30 56 92 / 14%); }
  .promote-panel { grid-template-columns: 1fr; }
  .promote-list { grid-column: auto; }
}

@media (max-width: 720px) {
  .chat-layout, .chat-layout.source-open { grid-template-columns: minmax(0, 1fr); }
  .conversation-sidebar { position: fixed; inset: 56px auto 0 0; z-index: 10; width: min(280px, 85vw); transform: translateX(-100%); box-shadow: 12px 0 30px rgb(30 56 92 / 16%); transition: transform 180ms ease; }
  .conversation-sidebar.mobile-open { transform: translateX(0); }
  .conversation-drawer-trigger, .conversation-sidebar-close { display: inline-grid; }
  .conversation-backdrop { position: fixed; inset: 56px 0 0; z-index: 9; border: 0; background: rgb(31 41 55 / 24%); }
  .conversation-backdrop.is-open { display: block; }
  .chat-conversation-header { padding: 0 14px; }
  .chat-conversation-header .secondary-button { padding: 0 9px; }
  .chat-message-scroll { padding: 22px 16px 18px; }
  .chat-composer-dock { padding: 10px 12px 12px; }
  .message-user { max-width: 88%; }
  .source-drawer { inset: 56px 0 0; width: 100%; }
  .promote-panel { margin: 0 12px; }
  .promote-controls { grid-template-columns: 1fr; }
  .promote-list li { align-items: stretch; flex-direction: column; }
  .promote-list li .secondary-button { width: 100%; }
}

@media (prefers-reduced-motion: reduce) {
  .conversation-sidebar { transition: none; }
}
```

- [ ] **Step 3: 运行自动验证**

Run: `npm run test:run -- src/app/App.test.tsx src/pages/ChatPage.test.tsx src/components/chat/MessageThread.test.tsx`

Expected: 所有定向测试通过。

Run: `npm run typecheck`

Expected: Web 和 Server 类型检查通过。

- [ ] **Step 4: 提交**

```bash
git add src/styles/app.css
git commit -m "style: refresh chat workspace layout"
```

### Task 5: 全量验证和浏览器验收

**Files:**
- Verify only; no source changes unless验收发现与本设计直接相关的问题。

- [ ] **Step 1: 运行全量自动检查**

```bash
npm run test:run
npm run typecheck
npm run build
git diff --check
```

Expected: 全部命令退出码为 0，无失败测试和类型错误。

- [ ] **Step 2: 浏览器验收桌面视口**

在 `http://localhost:5173/chat` 使用 1440px 宽视口验证：

- 聊天工作区占满顶部导航下方空间。
- 左侧会话列表和中间消息区可分别滚动。
- 输入区保持在中间栏底部。
- 来源打开后显示右侧独立栏。
- 结构区域之间没有可见分割线。

- [ ] **Step 3: 浏览器验收平板和手机视口**

使用 732px 和 390px 宽视口验证：

- 732px 下来源以右侧覆盖抽屉显示。
- 390px 下会话栏默认收起，按钮可打开和关闭左侧抽屉。
- 输入区保持可见，不遮挡消息或被抽屉挤压。
- 三种视口均无横向溢出、文字重叠和新增控制台错误。

- [ ] **Step 4: 最终提交状态检查**

Run: `git status --short --branch`

Expected: 当前分支无未提交文件。
