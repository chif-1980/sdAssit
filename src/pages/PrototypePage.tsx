import {
  BookOpen,
  Archive,
  ArchiveRestore,
  Check,
  ChevronRight,
  CircleCheck,
  Clock3,
  Download,
  FileText,
  Cloud,
  MessageCircle,
  PanelLeft,
  Plus,
  Send,
  Share2,
  Sparkles,
  Users,
  X,
} from 'lucide-react'
import { useMemo, useState } from 'react'

import type { ProductCitation } from '../../shared/api/product.js'
import { ChatComposer } from '../components/chat/ChatComposer'
import type { ComposerAttachment, ComposerMention } from '../components/chat/ChatComposer'
import { businessTasks, composerMentions, inferBusinessTask, taskDefinition, type BusinessTask } from '../components/chat/businessTasks'
import { materialShareFile, materialShareText, shareMaterialViaDevice, type MaterialShareChannel } from '../components/chat/materialSharing'
import { SourceDrawer } from '../components/chat/SourceDrawer'
import { ProductShell } from '../components/layout/ProductShell'

type PrototypeView = 'HOME' | 'CHAT'
type SkillTrigger = 'AUTO' | 'MENTION' | 'DEFAULT'

interface PrototypeTurn {
  id: string
  task: BusinessTask
  question: string
  answer: string
  trigger: SkillTrigger
}

interface PrototypeArchivedConversation {
  id: string
  title: string
  subtitle: string
  turns: PrototypeTurn[]
}

interface PrototypeMaterial {
  id: string
  type: string
  title: string
  fileName: string
  size: string
  updatedAt: string
  summary: string
  citation: ProductCitation
}

const shareChannels: { id: MaterialShareChannel; label: string; description: string; icon: typeof MessageCircle; supported: boolean }[] = [
  { id: 'WECHAT', label: '微信', description: '调用微信分享入口 · 手机端优先', icon: MessageCircle, supported: true },
  { id: 'FEISHU', label: '飞书', description: '调用飞书分享入口 · 手机端优先', icon: Cloud, supported: true },
  { id: 'DINGTALK', label: '钉钉', description: '后续接入', icon: Send, supported: false },
]

const materials: PrototypeMaterial[] = [
  {
    id: 'product-brief',
    type: '产品说明',
    title: 'Quickdone 企业知识助手｜产品说明 v3.2',
    fileName: 'Quickdone-企业知识助手-产品说明-v3.2.pdf',
    size: '2.4 MB',
    updatedAt: '2026-08-28',
    summary: '覆盖产品定位、核心能力、部署方式和常见限制，适合售前快速确认产品边界。',
    citation: {
      id: 'prototype-product-brief',
      kind: 'ENTERPRISE_EVIDENCE',
      title: 'Quickdone 企业知识助手｜产品说明 v3.2',
      path: '飞书知识库 / 产品资料 / 产品说明',
      locator: '第 2–8 页',
      excerpt: '企业知识助手面向市场、售前与交付团队，提供可核验的企业知识问答、资料检索和业务内容草拟能力。',
      versionAt: '2026-08-28T00:00:00.000Z',
    },
  },
  {
    id: 'sales-brochure',
    type: '宣传手册',
    title: 'Quickdone 企业服务宣传手册｜对外版',
    fileName: 'Quickdone-企业服务宣传手册-对外版.pdf',
    size: '6.8 MB',
    updatedAt: '2026-08-21',
    summary: '适合客户沟通和会前准备，包含价值主张、典型场景和落地案例。',
    citation: {
      id: 'prototype-sales-brochure',
      kind: 'ENTERPRISE_EVIDENCE',
      title: 'Quickdone 企业服务宣传手册｜对外版',
      path: '飞书知识库 / 市场资料 / 宣传手册',
      locator: '第 1–12 页',
      excerpt: '以客户可理解的语言介绍知识治理、智能问答与业务协作场景，并列出典型行业的落地成果。',
      versionAt: '2026-08-21T00:00:00.000Z',
    },
  },
  {
    id: 'retail-solution',
    type: '解决方案',
    title: '零售集团知识助手解决方案｜售前参考',
    fileName: '零售集团-知识助手解决方案-售前参考.pptx',
    size: '4.1 MB',
    updatedAt: '2026-08-19',
    summary: '围绕多门店知识统一、权限隔离和一线问答，提供可复用的售前叙事与实施路径。',
    citation: {
      id: 'prototype-retail-solution',
      kind: 'ENTERPRISE_EVIDENCE',
      title: '零售集团知识助手解决方案｜售前参考',
      path: '飞书知识库 / 解决方案 / 零售行业',
      locator: '第 3–18 页',
      excerpt: '方案采用“飞书原文存储 + 审核发布 + 权限检索”的路径，支持按组织和资料状态控制问答范围。',
      versionAt: '2026-08-19T00:00:00.000Z',
    },
  },
]

function materialCitation(material: PrototypeMaterial) {
  return material.citation
}

function defaultQuestion(task: BusinessTask) {
  if (task === 'QA') return '请直接回答我的企业知识问题，并列出可核验的引用来源。'
  return task === 'MATERIAL_SEARCH'
    ? '请帮我找一份产品说明、宣传手册和解决方案。'
    : taskDefinition(task)?.prompt ?? ''
}

function taskLabel(task: BusinessTask) {
  return task === 'QA' ? '直接问答' : taskDefinition(task)?.label ?? '技能'
}

function answerForTask(task: BusinessTask) {
  return task === 'QA'
    ? '这就是原有的企业知识问答：我会先检索正式资料，再给出带引用的回答。'
    : task === 'MATERIAL_SEARCH'
      ? '我已按“已审核、已发布、你有权限访问”的条件整理资料，请从下方卡片查看、下载或分发。'
      : task === 'SOLUTION_DRAFT'
        ? '已结合企业正式资料生成一版方案和汇报提纲，内容已标记为待人工确认。'
        : '已完成会议纪要的摘要、待办和产品建议提炼，结果仅在当前对话中可见。'
}

const initialArchivedConversation: PrototypeArchivedConversation = {
  id: 'prototype-archived-retail',
  title: '零售客户方案讨论',
  subtitle: '已归档 · 2026-08-26',
  turns: [{
    id: 'prototype-archived-retail-turn',
    task: 'SOLUTION_DRAFT',
    question: '请整理上次零售客户方案讨论的重点。',
    answer: answerForTask('SOLUTION_DRAFT'),
    trigger: 'AUTO',
  }],
}

function nextTurnId() {
  return `prototype-turn-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function downloadMaterial(material: PrototypeMaterial) {
  const body = materialShareText({
    title: material.title,
    fileName: material.fileName,
    size: material.size,
    summary: material.summary,
    sourcePath: material.citation.path,
  })
  const link = document.createElement('a')
  link.href = `data:text/plain;charset=utf-8,${encodeURIComponent(body)}`
  link.download = materialShareFile(material).name
  document.body.append(link)
  link.click()
  link.remove()
}

function PrototypeAssistant({ task, trigger, answer, onMaterialPreview, onDownload, onShare }: {
  task: BusinessTask
  trigger: SkillTrigger
  answer: string
  onMaterialPreview: (material: PrototypeMaterial) => void
  onDownload: (material: PrototypeMaterial) => void
  onShare: (material: PrototypeMaterial) => void
}) {
  const triggerText = trigger === 'DEFAULT'
    ? '直接问答'
    : `${trigger === 'AUTO' ? '自动调用' : '手动调用'} · ${taskLabel(task)}`

  if (task === 'QA') {
    return (
      <div className="prototype-answer prototype-qa-answer">
        <div className="prototype-skill-call"><span>本次调用技能</span><strong>{triggerText}</strong></div>
        <div className="prototype-answer-heading"><CircleCheck aria-hidden="true" size={17} /><strong>回答基于企业正式资料</strong><span>已审核 · 已发布</span></div>
        <p>{answer}</p>
        <div className="prototype-qa-source"><span>[1]</span><div><strong>企业知识问答规范</strong><small>飞书知识库 / 使用规范 · 第 1 页</small></div><ChevronRight aria-hidden="true" size={15} /></div>
      </div>
    )
  }

  if (task === 'MATERIAL_SEARCH') {
    return (
      <div className="prototype-answer">
        <div className="prototype-skill-call"><span>本次调用技能</span><strong>{triggerText}</strong></div>
        <div className="prototype-answer-heading">
          <CircleCheck aria-hidden="true" size={17} />
          <strong>找到 3 份可用资料</strong>
          <span>仅展示已审核、已发布且你有权限访问的内容</span>
        </div>
        <p>{answer}</p>
        <div className="prototype-material-list" aria-label="资料结果">
          {materials.map((material) => (
            <article key={material.id} className="prototype-material-card">
              <div className="prototype-material-icon" aria-hidden="true"><FileText size={18} /></div>
              <div className="prototype-material-main">
                <div className="prototype-material-title-row">
                  <span className="prototype-material-type">{material.type}</span>
                  <span className="prototype-material-status">已审核 · 已发布</span>
                </div>
                <h3>{material.title}</h3>
                <p>{material.summary}</p>
                <div className="prototype-material-meta">
                  <span><Clock3 aria-hidden="true" size={13} />更新于 {material.updatedAt}</span>
                  <span>{material.size}</span>
                </div>
                <div className="prototype-material-actions">
                  <button type="button" className="prototype-text-button" onClick={() => onMaterialPreview(material)}>查看摘要</button>
                  <button type="button" className="prototype-text-button" onClick={() => onDownload(material)}><Download aria-hidden="true" size={14} />下载</button>
                  <button type="button" className="prototype-text-button" onClick={() => onShare(material)}><Share2 aria-hidden="true" size={14} />分发</button>
                </div>
              </div>
              <button type="button" className="prototype-open-button" onClick={() => onMaterialPreview(material)}>
                打开飞书原文 <ChevronRight aria-hidden="true" size={15} />
              </button>
            </article>
          ))}
        </div>
        <p className="prototype-source-note">资料仍存放在飞书知识库，打开原文和下载均遵循飞书权限。</p>
      </div>
    )
  }

  if (task === 'SOLUTION_DRAFT') {
    return (
      <div className="prototype-answer">
        <div className="prototype-skill-call"><span>本次调用技能</span><strong>{triggerText}</strong></div>
        <div className="prototype-answer-heading prototype-answer-heading-amber">
          <Sparkles aria-hidden="true" size={17} />
          <strong>方案草稿已生成</strong>
          <span className="prototype-review-badge">待人工确认</span>
        </div>
        <p>{answer}</p>
        <div className="prototype-draft-grid">
          <section><span>01 · 客户现状</span><strong>多团队资料分散，售前需要快速复用正式内容。</strong></section>
          <section><span>02 · 建议方案</span><strong>以飞书为原文存储，接入审核发布和权限检索。</strong></section>
          <section><span>03 · 实施路径</span><strong>资料接入 → 审核发布 → 场景验证 → 分阶段上线。</strong></section>
          <section><span>汇报提纲</span><strong>现状与目标、方案架构、实施计划、风险与下一步。</strong></section>
        </div>
        <div className="prototype-draft-actions">
          <button type="button" className="primary-button">继续修改</button>
          <button type="button" className="secondary-button">重新生成</button>
        </div>
        <p className="prototype-source-note">本阶段只支持生成并下载方案文件，不提供在线编辑；报价单暂不在本轮原型范围内。</p>
      </div>
    )
  }

  return (
    <div className="prototype-answer">
      <div className="prototype-skill-call"><span>本次调用技能</span><strong>{triggerText}</strong></div>
      <div className="prototype-answer-heading prototype-answer-heading-purple">
        <Users aria-hidden="true" size={17} />
        <strong>会议纪要分析完成</strong>
        <span className="prototype-private-badge">私有分析结果</span>
      </div>
      <p>{answer}</p>
      <div className="prototype-meeting-meta" aria-label="会议基本信息">
        <span>内部产品讨论</span>
        <span>产品部</span>
        <span>未关联客户</span>
        <span>未关联项目</span>
      </div>
      <div className="prototype-meeting-grid">
        <section>
          <span>会议摘要</span>
          <p>团队围绕门店知识统一和权限隔离讨论试点范围，并确定先验证一线问答，再扩展到售前资料协作。</p>
        </section>
        <section>
          <span>待办事项</span>
          <ul>
            <li><Check aria-hidden="true" size={14} />林悦：补充门店组织架构（9 月 5 日）</li>
            <li><Check aria-hidden="true" size={14} />周启：确认试点资料清单（9 月 8 日）</li>
          </ul>
        </section>
        <section>
          <span>产品建议</span>
          <p>增加“按组织查看资料”的筛选，并在下载前展示资料审核状态。</p>
        </section>
      </div>
      <p className="prototype-source-note">客户和项目均为可选信息。分析结果不会自动进入知识库；整理后需人工提交审核。</p>
    </div>
  )
}

export function PrototypePage() {
  const [view, setView] = useState<PrototypeView>('HOME')
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<'CONCISE' | 'DETAILED'>('CONCISE')
  const [turns, setTurns] = useState<PrototypeTurn[]>([])
  const [selectedSkill, setSelectedSkill] = useState<BusinessTask>()
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [selectedMaterial, setSelectedMaterial] = useState<PrototypeMaterial>()
  const [shareMaterial, setShareMaterial] = useState<PrototypeMaterial>()
  const [shareFeedback, setShareFeedback] = useState<string>()
  const [toast, setToast] = useState<string>()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(() => new Set())
  const [showArchived, setShowArchived] = useState(false)
  const [archivedConversations, setArchivedConversations] = useState<PrototypeArchivedConversation[]>([initialArchivedConversation])
  const [selectedArchivedId, setSelectedArchivedId] = useState<string>()

  const selectedArchivedConversation = selectedArchivedId
    ? archivedConversations.find((item) => item.id === selectedArchivedId)
    : undefined
  const viewingArchived = Boolean(selectedArchivedConversation)
  const activeTaskLabel = selectedArchivedConversation?.title ?? (turns.length ? '统一对话' : '企业知识助手')
  const selectedSkillLabel = selectedSkill ? taskLabel(selectedSkill) : undefined
  const currentTurns = useMemo(() => selectedArchivedConversation?.turns ?? turns, [selectedArchivedConversation, turns])

  function showToast(message: string) {
    setToast(message)
    window.setTimeout(() => setToast(undefined), 2600)
  }

  function appendTurn(task: BusinessTask, question: string, trigger: SkillTrigger) {
    setTurns((current) => [...current, {
      id: nextTurnId(),
      task,
      question,
      answer: answerForTask(task),
      trigger,
    }])
  }

  function activateSkill(task: Exclude<BusinessTask, 'QA'>, showDemo = false) {
    setView('CHAT')
    setSidebarOpen(false)
    setSelectedArchivedId(undefined)
    setShowArchived(false)
    setSelectedSkill(task)
    setAttachments([])
    if (showDemo) {
      const question = defaultQuestion(task)
      appendTurn(task, question, 'MENTION')
      setSelectedSkill(undefined)
      setDraft('')
    } else {
      setDraft(defaultQuestion(task))
    }
  }

  function startNewConversation() {
    setView('HOME')
    setTurns([])
    setSelectedSkill(undefined)
    setDraft('')
    setAttachments([])
    setSidebarOpen(false)
    setSelectedMaterial(undefined)
    setShareMaterial(undefined)
    setShareFeedback(undefined)
    setSelectedArchivedId(undefined)
    setShowArchived(false)
  }

  function selectArchivedConversation(id: string) {
    setSelectedArchivedId(id)
    setSelectedSkill(undefined)
    setDraft('')
    setAttachments([])
    setView('CHAT')
    setSidebarOpen(false)
  }

  function archiveCurrentConversation() {
    if (!turns.length) return
    const firstQuestion = turns[0]?.question.trim() ?? ''
    const title = firstQuestion.length > 26 ? `${firstQuestion.slice(0, 26)}…` : firstQuestion || '未命名对话'
    const archived: PrototypeArchivedConversation = {
      id: `prototype-archived-${Date.now()}`,
      title,
      subtitle: `已归档 · ${new Date().toISOString().slice(0, 10)}`,
      turns,
    }
    setArchivedConversations((current) => [archived, ...current])
    setSelectedArchivedId(archived.id)
    setShowArchived(true)
    setTurns([])
    setSelectedSkill(undefined)
    setDraft('')
    setAttachments([])
    showToast('已归档当前对话，可在“已归档”中恢复')
  }

  function restoreArchivedConversation() {
    if (!selectedArchivedConversation) return
    setTurns(selectedArchivedConversation.turns)
    setArchivedConversations((current) => current.filter((item) => item.id !== selectedArchivedConversation.id))
    setSelectedArchivedId(undefined)
    setShowArchived(false)
    setView('CHAT')
    showToast('已恢复对话，可继续提问')
  }

  function selectMention(mention: ComposerMention) {
    const task = businessTasks.find((item) => item.label === mention.label)
    if (task) activateSkill(task.id, false)
  }

  function acceptFiles(files: File[]) {
    const next = files.slice(0, 5).map((file) => ({
      id: `prototype-${file.name}-${file.size}-${file.lastModified}`,
      file,
      status: 'PENDING' as const,
    }))
    if (next.length) setAttachments(next)
  }

  function handleDownload(material: PrototypeMaterial) {
    downloadMaterial(material)
    setDownloadedIds((current) => new Set(current).add(material.id))
    showToast(`已下载「${material.fileName}」`)
  }

  function handleShare(material: PrototypeMaterial) {
    setShareFeedback(undefined)
    setShareMaterial(material)
  }

  async function invokeShareChannel(channel: MaterialShareChannel) {
    const target = shareChannels.find((item) => item.id === channel)
    if (!target || !shareMaterial) return
    if (!target.supported) {
      setShareFeedback(`${target.label}分发入口将在后续阶段接入`)
      return
    }

    try {
      const result = await shareMaterialViaDevice(shareMaterial, channel)
      if (result === 'SHARED') {
        setShareFeedback(`已打开${target.label}手机端分享面板，请在客户端选择联系人或群`)
      } else if (result === 'CANCELLED') {
        setShareFeedback('已取消分享，资料仍可下载后再发送')
      } else {
        // Desktop browsers and older mobile browsers do not expose the Web
        // Share API. Downloading keeps the flow usable and lets the user use
        // the native system share sheet on the phone.
        handleDownload(shareMaterial)
        setShareFeedback(`已调用${target.label}分发入口：已准备资料，请在手机系统分享面板中选择${target.label}`)
      }
    } catch {
      setShareFeedback(`暂时无法打开${target.label}分享入口，请先下载资料后发送`)
    }
    window.dispatchEvent(new CustomEvent('quickdone:distribution', {
      detail: { channel, materialId: shareMaterial.id, fileName: shareMaterial.fileName, mode: 'MOBILE_OR_SYSTEM_SHARE' },
    }))
  }

  function handleSubmit() {
    const rawQuestion = draft.trim()
    if (!rawQuestion) return

    const mentionedTask = businessTasks.find((item) => rawQuestion.startsWith(`@${item.label}`))?.id
    const task = selectedSkill && selectedSkill !== 'QA'
      ? selectedSkill
      : mentionedTask ?? inferBusinessTask(rawQuestion)
    const trigger: SkillTrigger = selectedSkill || mentionedTask
      ? 'MENTION'
      : task === 'QA' ? 'DEFAULT' : 'AUTO'

    setView('CHAT')
    setSelectedArchivedId(undefined)
    setShowArchived(false)
    appendTurn(task, rawQuestion, trigger)
    setSelectedSkill(undefined)
    setDraft('')
    setAttachments([])
  }

  const sourceDrawerCitation = selectedMaterial ? materialCitation(selectedMaterial) : undefined

  return (
    <ProductShell>
      <section className="chat-page prototype-page" aria-label="企业知识助手原型">
        <div className={`chat-layout prototype-layout${selectedMaterial ? ' source-open' : ''}`}>
          <aside className={`conversation-sidebar prototype-sidebar${sidebarOpen ? ' mobile-open' : ''}`} aria-label="最近对话列表">
            <div className="sidebar-heading">
              <h2>最近对话</h2>
              <button type="button" className="icon-button conversation-sidebar-close" aria-label="关闭对话列表" onClick={() => setSidebarOpen(false)}><X aria-hidden="true" size={17} /></button>
            </div>
            <div className="conversation-sidebar-actions">
              <button type="button" className="new-conversation-button" onClick={startNewConversation}><Plus aria-hidden="true" size={17} />新对话</button>
              <button type="button" className={`archived-conversations-button${showArchived ? ' active' : ''}`} aria-pressed={showArchived} onClick={() => setShowArchived((current) => !current)}>
                <ArchiveRestore aria-hidden="true" size={15} />
                <span>已归档</span>
                <span className="archived-conversations-count">{archivedConversations.length}</span>
              </button>
            </div>
            <ul>
              {showArchived ? archivedConversations.map((item) => (
                <li key={item.id}>
                  <button type="button" className={`conversation-link${selectedArchivedId === item.id ? ' active' : ''}`} onClick={() => selectArchivedConversation(item.id)}>
                    <span>{item.title}</span><small>{item.subtitle}</small>
                  </button>
                </li>
              )) : (
                <li>
                  <button type="button" className={`conversation-link${view === 'CHAT' && !viewingArchived ? ' active' : ''}`} onClick={() => { setSelectedArchivedId(undefined); setView('CHAT') }}>
                    <span>{turns.length ? '当前对话' : '新对话'}</span><small>直接问答 · AI 自动调用技能</small>
                  </button>
                </li>
              )}
              {showArchived && !archivedConversations.length ? <li className="conversation-list-empty">暂无已归档会话</li> : null}
            </ul>
            <p className="prototype-sidebar-note">一个对话即可处理问答、资料、方案和会议。历史内容可在“已归档”中查找并恢复。</p>
          </aside>

          <main className="chat-main prototype-main">
            <header className="chat-conversation-header prototype-header">
              <div className="prototype-header-leading">
                <button type="button" className="icon-button conversation-drawer-trigger" aria-label="打开最近对话列表" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(true)}><PanelLeft aria-hidden="true" size={18} /></button>
                <div className="chat-conversation-title">
                  <strong>{activeTaskLabel}</strong>
                  <span className="chat-task-chip">本地原型</span>
                  {viewingArchived ? <span className="archive-label">已归档</span> : null}
                  {view === 'HOME' ? <span className="prototype-header-subtitle">一个对话，按需调用技能</span> : null}
                </div>
              </div>
              <div className="prototype-header-actions">
                {viewingArchived ? <button type="button" className="icon-button" aria-label="恢复当前会话" title="恢复当前会话" onClick={restoreArchivedConversation}><ArchiveRestore aria-hidden="true" size={17} /></button> : null}
                {!viewingArchived && turns.length ? <button type="button" className="icon-button" aria-label="归档当前对话" title="归档当前对话" onClick={archiveCurrentConversation}><Archive aria-hidden="true" size={17} /></button> : null}
                <button type="button" className="prototype-new-conversation-button" onClick={startNewConversation}><Plus aria-hidden="true" size={15} />新对话</button>
              </div>
            </header>

            <div className="chat-message-area">
              <div className="chat-message-scroll prototype-scroll">
                {view === 'HOME' ? (
                  <div className="prototype-home">
                    <div className="prototype-hero">
                      <span className="prototype-eyebrow">统一对话入口 · 原型预览</span>
                      <h2>让每一次工作协作，<em>都从一个对话开始。</em></h2>
                      <p>像原来一样直接提问。需要查资料、做方案或分析会议时，AI 会自动调用合适技能；也可以输入 @ 手动选择。</p>
                    </div>
                    <div className="prototype-default-skill">
                      <span className="prototype-default-skill-icon"><MessageCircle aria-hidden="true" size={17} /></span>
                      <span><strong>默认能力 · 直接问答</strong><small>基于已审核、已发布且你有权限访问的企业资料，回答并保留引用。</small></span>
                    </div>
                    <div className="prototype-skill-strip" aria-label="可调用技能">
                      <span className="prototype-skill-strip-label">可调用技能</span>
                      {businessTasks.map((task) => {
                        const Icon = task.icon
                        return (
                          <button key={task.id} type="button" className="prototype-skill-chip" aria-label={`调用${task.label}`} onClick={() => activateSkill(task.id, true)}>
                            <Icon aria-hidden="true" size={15} />
                            <span>@{task.label}</span>
                          </button>
                        )
                      })}
                    </div>
                    <div className="prototype-example-prompts">
                      <span>可以这样问</span>
                      <button type="button" onClick={() => setDraft('产品标准部署需要哪些前置条件？')}>产品标准部署需要哪些前置条件？</button>
                      <button type="button" onClick={() => setDraft('找一份零售行业的产品说明和解决方案')}>找一份零售行业的产品说明和解决方案</button>
                    </div>
                    <div className="prototype-home-note"><BookOpen aria-hidden="true" size={15} /><span>资料原文只存放在飞书知识库，助手不会复制到其他位置</span></div>
                  </div>
                ) : (
                  <div className="prototype-thread">
                    {currentTurns.map((turn) => (
                      <div key={turn.id} className="prototype-turn">
                        <article className="prototype-question"><span>你</span><p>{turn.question}</p></article>
                        <article className="prototype-assistant"><div className="prototype-message-role"><span>助手</span><span>统一对话</span></div><PrototypeAssistant task={turn.task} trigger={turn.trigger} answer={turn.answer} onMaterialPreview={setSelectedMaterial} onDownload={handleDownload} onShare={handleShare} /></article>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="chat-composer-dock prototype-composer-dock">
              {selectedSkillLabel ? (
                <div className="prototype-selected-skill" role="status">
                  <span>已选择技能</span><strong>@{selectedSkillLabel}</strong>
                  <button type="button" aria-label="取消技能选择" onClick={() => { setSelectedSkill(undefined); setDraft('') }}><X aria-hidden="true" size={13} /></button>
                </div>
              ) : null}
              <ChatComposer
                value={draft}
                mode={mode}
                disabled={false}
                placeholder={selectedSkillLabel ? `已选择 @${selectedSkillLabel}，补充你的具体要求` : '直接提问，或输入 @ 调用技能'}
                attachments={attachments}
                onChange={setDraft}
                onModeChange={setMode}
                onFiles={acceptFiles}
                onRemoveAttachment={(id) => setAttachments((current) => current.filter((item) => item.id !== id))}
                mentions={composerMentions}
                onMentionSelect={selectMention}
                onSubmit={handleSubmit}
              />
              <p className="prototype-composer-hint">默认使用直接问答 · 输入 @ 查看并调用技能 · 支持上传附件</p>
            </div>
          </main>

          <SourceDrawer citation={sourceDrawerCitation} modal={false} openHref="https://example.feishu.cn/wiki/prototype" onClose={() => setSelectedMaterial(undefined)} />
        </div>
        {sidebarOpen ? <button type="button" className="conversation-backdrop is-open" aria-label="关闭对话列表" onClick={() => setSidebarOpen(false)} /> : null}
        {toast ? <div className="prototype-toast" role="status"><Check aria-hidden="true" size={15} />{toast}</div> : null}
        {shareMaterial ? (
          <div className="prototype-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShareMaterial(undefined) }}>
            <section className="prototype-share-modal" role="dialog" aria-modal="true" aria-labelledby="prototype-share-title">
              <div className="prototype-modal-heading"><div><span className="prototype-modal-kicker">调用分发入口 · 手机端优先</span><h2 id="prototype-share-title">分发「{shareMaterial.type}」</h2></div><button type="button" className="icon-button" aria-label="关闭分发面板" onClick={() => setShareMaterial(undefined)}><X aria-hidden="true" size={18} /></button></div>
              <p className="prototype-share-file"><FileText aria-hidden="true" size={17} /><span>{shareMaterial.fileName}</span><small>{shareMaterial.size}</small></p>
              <div className="prototype-share-steps"><div><span>1</span><p><strong>确认资料</strong><small>{downloadedIds.has(shareMaterial.id) ? '资料已下载，可直接调用分发' : '未下载时会先准备文件，不改变飞书原文权限'}</small></p></div><div><span>2</span><p><strong>选择发送渠道</strong><small>手机端优先打开分享面板；桌面端自动下载后使用系统分享</small></p></div></div>
              <div className="prototype-channel-grid">
                {shareChannels.map((channel) => {
                  const Icon = channel.icon
                  return <button key={channel.id} type="button" className={`prototype-channel-button${channel.supported ? '' : ' is-disabled'}`} disabled={!channel.supported} onClick={() => void invokeShareChannel(channel.id)}><span className={`prototype-channel-icon prototype-channel-${channel.id.toLowerCase()}`}><Icon aria-hidden="true" size={17} /></span><span><strong>{channel.label}</strong><small>{channel.description}</small></span><ChevronRight aria-hidden="true" size={14} /></button>
                })}
              </div>
              {shareFeedback ? <div className="prototype-share-feedback" role="status"><Check aria-hidden="true" size={15} />{shareFeedback}</div> : null}
              <div className="prototype-modal-actions"><button type="button" className="secondary-button" onClick={() => handleDownload(shareMaterial)}><Download aria-hidden="true" size={15} />{downloadedIds.has(shareMaterial.id) ? '再次下载' : '下载资料'}</button><button type="button" className="primary-button" onClick={() => { setShareMaterial(undefined); setShareFeedback(undefined) }}>关闭</button></div>
              <p className="prototype-share-note">原型优先模拟手机端调用。正式接入时使用飞书、微信官方分享能力或系统分享面板；不会生成公开链接或突破飞书权限。</p>
            </section>
          </div>
        ) : null}
      </section>
    </ProductShell>
  )
}
