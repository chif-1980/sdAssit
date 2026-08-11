# Knowledge Platform V1 重建 Implementation Plan

> **面向执行代理：** 必须使用 `subagent-driven-development`（推荐）或 `executing-plans`，逐项执行本计划；所有步骤使用复选框跟踪，未验证通过不得进入下一任务。

**目标：** 完整备份并清理旧工程，从零构建一个无需外部凭据即可运行的 Knowledge Platform V1，跑通“资料 → 知识”“知识 → 回答”“错误 → 修复”三条闭环。

**架构：** React Web 只调用 Fastify 应用 API；纯 TypeScript 领域核心定义五个业务对象与状态机；本地 JSON Repository、确定性 AI、检索和索引适配器实现 V1，Feishu、真实 LLM 与 OpenSearch 通过相同端口后续替换。

**技术栈：** React 18、TypeScript、Vite、React Router、lucide-react、Fastify、Zod、ULID、Vitest、Testing Library、Node.js。

---

## 文件结构

```text
KnowledgeBase/
├── docs/superpowers/
│   ├── specs/2026-08-11-knowledge-platform-v1-rebuild-design.md
│   └── plans/2026-08-11-knowledge-platform-v1-rebuild.md
├── shared/domain/
│   ├── enums.ts
│   ├── models.ts
│   ├── schema.ts
│   ├── ids.ts
│   ├── rules.ts
│   └── rules.test.ts
├── server/
│   ├── index.ts
│   ├── app.ts
│   ├── seed.ts
│   ├── application/
│   │   ├── ports.ts
│   │   ├── assetService.ts
│   │   ├── reviewService.ts
│   │   └── conversationService.ts
│   ├── adapters/
│   │   ├── jsonRepository.ts
│   │   ├── deterministicAi.ts
│   │   ├── localRetrieval.ts
│   │   └── localIndexer.ts
│   ├── routes/
│   │   ├── sessionRoutes.ts
│   │   ├── assetRoutes.ts
│   │   ├── reviewRoutes.ts
│   │   ├── knowledgeRoutes.ts
│   │   └── conversationRoutes.ts
│   └── tests/
│       ├── jsonRepository.test.ts
│       ├── assetFlow.test.ts
│       ├── reviewFlow.test.ts
│       └── conversationFlow.test.ts
├── src/
│   ├── main.tsx
│   ├── app/App.tsx
│   ├── api/client.ts
│   ├── session/SessionProvider.tsx
│   ├── components/
│   │   ├── layout/ProductShell.tsx
│   │   ├── layout/FactoryNav.tsx
│   │   ├── chat/ChatComposer.tsx
│   │   ├── chat/MessageThread.tsx
│   │   ├── chat/SourceDrawer.tsx
│   │   └── ui/AsyncState.tsx
│   ├── pages/
│   │   ├── ChatPage.tsx
│   │   ├── FactoryWorkbenchPage.tsx
│   │   ├── AssetListPage.tsx
│   │   ├── AssetDetailPage.tsx
│   │   ├── ReviewListPage.tsx
│   │   ├── ReviewDetailPage.tsx
│   │   ├── KnowledgeListPage.tsx
│   │   └── KnowledgeDetailPage.tsx
│   ├── styles/tokens.css
│   ├── styles/global.css
│   └── test/setup.ts
├── data/.gitkeep
├── package.json
├── tsconfig.web.json
├── tsconfig.server.json
├── vite.config.ts
└── vitest.config.ts
```

`data/knowledge-platform.json` 是运行时数据，不提交 Git。

## 任务 1：完整备份并安全清理旧工程

**文件：**

- 备份目录：`/Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase-backup-20260811`
- 清理目录：`/Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase`
- 保留文档：设计文档与本实施计划

- [ ] **步骤 1：确认精确目标与备份目录不存在**

运行：

```bash
test "$(pwd)" = "/Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase"
test ! -e /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase-backup-20260811
find /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase -mindepth 1 -maxdepth 1 -print | sort
```

预期：当前目录精确匹配；备份目录不存在；输出仅为当前项目的顶层内容。任一检查失败立即停止，不创建第二个同名备份，也不清理文件。

- [ ] **步骤 2：创建完整备份**

运行：

```bash
ditto /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase-backup-20260811
```

预期：命令退出码为 0；备份包含 `node_modules`、`dist`、隐藏目录、源码、测试和文档。

- [ ] **步骤 3：验证备份可恢复**

运行：

```bash
find /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase -type f | wc -l
find /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase-backup-20260811 -type f | wc -l
du -sk /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase
du -sk /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase-backup-20260811
diff -qr /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase-backup-20260811
```

预期：文件数一致、总 KB 一致、`diff -qr` 没有输出。验证不通过时停止，保留两个目录并报告差异。

- [ ] **步骤 4：删除经过验证的旧工程内容**

先再次列出目标，然后只删除以下已确认的旧路径：

```bash
rm -rf \
  /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase/.superpowers \
  /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase/dist \
  /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase/docs \
  /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase/node_modules \
  /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase/server \
  /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase/src
rm -f \
  /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase/.env.example \
  /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase/index.html \
  /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase/package.json \
  /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase/package-lock.json \
  /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase/tsconfig.json \
  /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase/tsconfig.node.json \
  /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase/tsconfig.node.tsbuildinfo \
  /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase/tsconfig.tsbuildinfo \
  /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase/vite.config.d.ts \
  /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase/vite.config.js \
  /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase/vite.config.ts \
  /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase/vitest.config.ts
```

预期：工作区为空；备份目录仍存在且大小未变化。删除内容可从已验证备份恢复。

- [ ] **步骤 5：恢复新设计文档与计划**

运行：

```bash
mkdir -p /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase/docs/superpowers/specs
mkdir -p /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase/docs/superpowers/plans
cp /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase-backup-20260811/docs/superpowers/specs/2026-08-11-knowledge-platform-v1-rebuild-design.md /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase/docs/superpowers/specs/
cp /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase-backup-20260811/docs/superpowers/plans/2026-08-11-knowledge-platform-v1-rebuild.md /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase/docs/superpowers/plans/
```

预期：新工作区只包含两份已批准的重建文档。

## 任务 2：建立新项目基础与质量门槛

**文件：**

- 创建：`package.json`
- 创建：`index.html`
- 创建：`tsconfig.web.json`
- 创建：`tsconfig.server.json`
- 创建：`vite.config.ts`
- 创建：`vitest.config.ts`
- 创建：`.gitignore`
- 创建：`src/main.tsx`
- 创建：`src/app/App.tsx`
- 创建：`src/test/setup.ts`
- 创建：`server/index.ts`

- [ ] **步骤 1：初始化 Git 和依赖清单**

运行：

```bash
git init -b main
npm init -y
npm install react@18 react-dom@18 react-router-dom@6 lucide-react fastify zod ulid
npm install -D @vitejs/plugin-react @testing-library/jest-dom @testing-library/react @testing-library/user-event @types/node @types/react @types/react-dom concurrently jsdom tsx typescript vite vitest
```

把 `package.json` 的脚本改成：

```json
{
  "scripts": {
    "dev": "concurrently -k -n api,web npm:dev:server npm:dev:web",
    "dev:web": "vite",
    "dev:server": "tsx watch server/index.ts",
    "server": "tsx server/index.ts",
    "test": "vitest",
    "test:run": "vitest run --passWithNoTests",
    "typecheck": "tsc -p tsconfig.web.json --noEmit && tsc -p tsconfig.server.json --noEmit",
    "build": "npm run typecheck && vite build"
  }
}
```

- [ ] **步骤 2：写入 TypeScript、Vite 和测试配置**

`tsconfig.web.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "allowJs": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx"
  },
  "include": ["src", "shared"]
}
```

`tsconfig.server.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["server", "shared", "vite.config.ts", "vitest.config.ts"]
}
```

`vite.config.ts`：

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
})
```

`vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['shared/**/*.test.ts', 'server/**/*.test.ts', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
```

- [ ] **步骤 3：建立最小前后端入口**

`src/app/App.tsx`：

```tsx
export default function App() {
  return <main><h1>Knowledge Platform</h1></main>
}
```

`src/main.tsx`：

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './app/App'

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
```

`server/index.ts`：

```ts
import Fastify from 'fastify'

const app = Fastify({ logger: true })
app.get('/api/health', async () => ({ ok: true, provider: 'local-json' }))
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 8787) })
```

`src/test/setup.ts`：

```ts
import '@testing-library/jest-dom/vitest'
```

`index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Knowledge Platform</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

创建运行时数据目录占位：

```bash
mkdir -p data
touch data/.gitkeep
```

`.gitignore`：

```gitignore
node_modules/
dist/
coverage/
data/knowledge-platform.json
*.tsbuildinfo
.DS_Store
.env
```

- [ ] **步骤 4：验证新项目基础**

运行：

```bash
npm run typecheck
npm run test:run
npm run build
```

预期：类型检查通过；Vitest 报告没有测试文件但进程正常结束；Vite 生成 `dist/index.html`。

- [ ] **步骤 5：提交基础工程**

```bash
git add .gitignore docs index.html package.json package-lock.json src server tsconfig.web.json tsconfig.server.json vite.config.ts vitest.config.ts
git commit -m "chore: rebuild knowledge platform foundation"
```

## 任务 3：建立五个领域对象和状态规则

**文件：**

- 创建：`shared/domain/enums.ts`
- 创建：`shared/domain/models.ts`
- 创建：`shared/domain/ids.ts`
- 创建：`shared/domain/schema.ts`
- 创建：`shared/domain/rules.ts`
- 测试：`shared/domain/rules.test.ts`

- [ ] **步骤 1：先写失败的领域规则测试**

`shared/domain/rules.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { allowedReviewActions, canAnswerWithKnowledge, validateKnowledgeAuthority } from './rules.js'

describe('knowledge rules', () => {
  it('只允许已索引的生效知识进入回答', () => {
    expect(canAnswerWithKnowledge({ status: 'ACTIVE', aiEnabled: true, indexStatus: 'INDEXED' })).toBe(true)
    expect(canAnswerWithKnowledge({ status: 'ACTIVE', aiEnabled: true, indexStatus: 'PENDING' })).toBe(false)
    expect(canAnswerWithKnowledge({ status: 'STALE', aiEnabled: true, indexStatus: 'INDEXED' })).toBe(false)
  })

  it('正式知识权威等级不能高于主来源', () => {
    expect(() => validateKnowledgeAuthority('L3', 'L1')).toThrow('KNOWLEDGE_AUTHORITY_EXCEEDS_SOURCE')
    expect(() => validateKnowledgeAuthority('L2', 'L2')).not.toThrow()
  })

  it('冲突审核允许创建新知识', () => {
    expect(allowedReviewActions('CONFLICT')).toContain('CREATE_KNOWLEDGE')
    expect(allowedReviewActions('NEW')).not.toContain('ARCHIVE_KNOWLEDGE')
  })
})
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`npm run test:run -- shared/domain/rules.test.ts`

预期：FAIL，提示 `rules.ts` 或导出函数不存在。

- [ ] **步骤 3：实现枚举、模型和 ID**

`shared/domain/enums.ts`：

```ts
export type Authority = 'L0' | 'L1' | 'L2' | 'L3'
export type Risk = 'LOW' | 'MEDIUM' | 'HIGH'
export type UserRole = 'EMPLOYEE' | 'OWNER' | 'ADMIN'
export type AssetType = 'DOCUMENT' | 'AUDIO' | 'VIDEO' | 'IMAGE'
export type BusinessType = 'PRODUCT_DOCUMENT' | 'SOLUTION' | 'POLICY' | 'PROCESS' | 'TRAINING' | 'CUSTOMER_MEETING' | 'INTERNAL_MEETING' | 'PROJECT_DOCUMENT' | 'SESSION_UPLOAD' | 'OTHER'
export type ProcessStatus = 'NEW' | 'PROCESSING' | 'PROCESSED' | 'FAILED'
export type KnowledgeType = 'PRODUCT_CAPABILITY' | 'PRODUCT_PARAMETER' | 'TECHNICAL' | 'FAQ' | 'PROCESS' | 'POLICY' | 'BEST_PRACTICE' | 'PROJECT' | 'OTHER'
export type Relation = 'NEW' | 'DUPLICATE' | 'UPDATE' | 'CONFLICT'
export type CandidateStatus = 'PENDING' | 'APPROVED' | 'REJECTED'
export type TriggerType = 'CANDIDATE' | 'USER_FEEDBACK' | 'LIFECYCLE' | 'SOURCE_CHANGE'
export type ReviewType = 'NEW' | 'UPDATE' | 'CONFLICT' | 'STALE'
export type ReviewStatus = 'PENDING' | 'RESOLVED' | 'CANCELLED'
export type ResolutionAction = 'CREATE_KNOWLEDGE' | 'UPDATE_KNOWLEDGE' | 'KEEP_CURRENT' | 'REJECT_CANDIDATE' | 'ARCHIVE_KNOWLEDGE' | 'CONFIRM_VALID'
export type FeedbackType = 'WRONG' | 'OUTDATED' | 'MISSING' | 'CITATION_ERROR' | 'OTHER'
export type KnowledgeStatus = 'ACTIVE' | 'STALE' | 'ARCHIVED'
export type IndexStatus = 'PENDING' | 'INDEXED' | 'FAILED'
export type ConversationScope = 'ENTERPRISE' | 'SESSION' | 'BOTH'
export type ConversationStatus = 'ACTIVE' | 'ARCHIVED'
export type MessageRole = 'USER' | 'ASSISTANT'
```

`shared/domain/ids.ts`：

```ts
import { ulid } from 'ulid'

const prefixes = { asset: 'AST', candidate: 'KCD', knowledge: 'KNW', review: 'RVW', conversation: 'CVS' } as const
export type IdKind = keyof typeof prefixes
export const createBusinessId = (kind: IdKind) => `${prefixes[kind]}-${ulid()}`
```

`shared/domain/models.ts`：

```ts
import type {
  AssetType, Authority, BusinessType, CandidateStatus, ConversationScope,
  ConversationStatus, FeedbackType, IndexStatus, KnowledgeStatus, KnowledgeType,
  MessageRole, ProcessStatus, Relation, ResolutionAction, ReviewStatus, ReviewType,
  Risk, TriggerType, UserRole,
} from './enums.js'

export interface User { id: string; name: string; role: UserRole }
export interface AssetSection { id: string; title: string; locator: string; excerpt: string }
export interface Asset {
  id: string; title: string; assetType: AssetType; businessType: BusinessType;
  provider: 'LOCAL'; externalId: string; sourceUrl?: string; ownerId: string;
  authority: Authority; processStatus: ProcessStatus; summary?: string;
  contentHash?: string; errorMessage?: string; sourceModifiedAt?: string;
  processedAt?: string; createdAt: string; updatedAt: string;
  isSessionAsset: boolean; expiresAt?: string; sections: AssetSection[];
}
export interface Candidate {
  id: string; title: string; content: string; knowledgeType: KnowledgeType;
  sourceAssetId: string; sourceLocator: string; sourceExcerpt: string;
  authority: Authority; confidence: number; relation: Relation;
  existingKnowledgeId?: string; aiReason: string; status: CandidateStatus;
  reviewRequired: boolean; reviewerId?: string; candidateHash: string;
  createdAt: string; reviewedAt?: string;
}
export interface Knowledge {
  id: string; title: string; content: string; category: KnowledgeType; tags: string[];
  authority: Authority; ownerId: string; primaryAssetId: string;
  supportingAssetIds: string[]; sourceLocator: string; status: KnowledgeStatus;
  version: number; validFrom?: string; validTo?: string; lastVerifiedAt: string;
  staleReason?: string; aiEnabled: boolean; indexStatus: IndexStatus;
  createdAt: string; updatedAt: string;
}
export interface Review {
  id: string; title: string; triggerType: TriggerType; reviewType: ReviewType;
  candidateId?: string; targetKnowledgeId?: string; risk: Risk;
  currentSnapshot?: string; proposedContent?: string; aiSuggestion?: string;
  reviewerId: string; status: ReviewStatus; resolutionAction?: ResolutionAction;
  finalContent?: string; decisionComment?: string; conversationId?: string;
  feedbackType?: FeedbackType; feedbackText?: string; createdAt: string;
  dueAt?: string; resolvedAt?: string;
}
export interface Conversation {
  id: string; title: string; userId: string; topic?: string; scope: ConversationScope;
  summary?: string; sessionAssetIds: string[]; status: ConversationStatus;
  messageCount: number; negativeFeedbackCount: number; hasOpenIssue: boolean;
  lastFeedbackType?: FeedbackType; lastFeedbackText?: string;
  createdAt: string; lastActiveAt: string;
}
export interface Citation { knowledgeId: string; title: string; assetId: string; locator: string; excerpt: string }
export interface MessageFeedback { helpful: boolean; type?: FeedbackType; text?: string; createdAt: string }
export interface ConversationMessage {
  id: string; conversationId: string; role: MessageRole; text: string;
  citations: Citation[]; createdAt: string; feedback?: MessageFeedback;
}
export interface PlatformSnapshot {
  version: 1;
  session: { userId: string; role: UserRole };
  users: User[]; assets: Asset[]; candidates: Candidate[]; knowledge: Knowledge[];
  reviews: Review[]; conversations: Conversation[]; messages: ConversationMessage[];
  assetInputs: Record<string, { content: string; mimeType: string }>;
}
```

`assetInputs` 是本地 Adapter 保存待解析文本的基础设施集合，不是第六个业务对象，未来由 Feishu Drive Adapter 替换。

`shared/domain/schema.ts` 为上述接口建立严格 Zod schema；完整顶层结构与错误契约如下，字段 schema 必须逐一对应 `models.ts`：

```ts
import { z } from 'zod'
import type { PlatformSnapshot } from './models.js'

const authority = z.enum(['L0', 'L1', 'L2', 'L3'])
const iso = z.string().datetime()
const assetSection = z.object({ id: z.string(), title: z.string(), locator: z.string(), excerpt: z.string() }).strict()
const asset = z.object({
  id: z.string(), title: z.string(), assetType: z.enum(['DOCUMENT', 'AUDIO', 'VIDEO', 'IMAGE']),
  businessType: z.enum(['PRODUCT_DOCUMENT', 'SOLUTION', 'POLICY', 'PROCESS', 'TRAINING', 'CUSTOMER_MEETING', 'INTERNAL_MEETING', 'PROJECT_DOCUMENT', 'SESSION_UPLOAD', 'OTHER']),
  provider: z.literal('LOCAL'), externalId: z.string(), sourceUrl: z.string().optional(), ownerId: z.string(), authority,
  processStatus: z.enum(['NEW', 'PROCESSING', 'PROCESSED', 'FAILED']), summary: z.string().optional(),
  contentHash: z.string().optional(), errorMessage: z.string().optional(), sourceModifiedAt: iso.optional(), processedAt: iso.optional(),
  createdAt: iso, updatedAt: iso, isSessionAsset: z.boolean(), expiresAt: iso.optional(), sections: z.array(assetSection),
}).strict()
const candidate = z.object({
  id: z.string(), title: z.string(), content: z.string(), knowledgeType: z.enum(['PRODUCT_CAPABILITY', 'PRODUCT_PARAMETER', 'TECHNICAL', 'FAQ', 'PROCESS', 'POLICY', 'BEST_PRACTICE', 'PROJECT', 'OTHER']),
  sourceAssetId: z.string(), sourceLocator: z.string(), sourceExcerpt: z.string(), authority, confidence: z.number().min(0).max(1),
  relation: z.enum(['NEW', 'DUPLICATE', 'UPDATE', 'CONFLICT']), existingKnowledgeId: z.string().optional(), aiReason: z.string(),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']), reviewRequired: z.boolean(), reviewerId: z.string().optional(),
  candidateHash: z.string(), createdAt: iso, reviewedAt: iso.optional(),
}).strict()
const knowledge = z.object({
  id: z.string(), title: z.string(), content: z.string(), category: z.enum(['PRODUCT_CAPABILITY', 'PRODUCT_PARAMETER', 'TECHNICAL', 'FAQ', 'PROCESS', 'POLICY', 'BEST_PRACTICE', 'PROJECT', 'OTHER']),
  tags: z.array(z.string()), authority, ownerId: z.string(), primaryAssetId: z.string(), supportingAssetIds: z.array(z.string()),
  sourceLocator: z.string(), status: z.enum(['ACTIVE', 'STALE', 'ARCHIVED']), version: z.number().int().positive(),
  validFrom: iso.optional(), validTo: iso.optional(), lastVerifiedAt: iso, staleReason: z.string().optional(), aiEnabled: z.boolean(),
  indexStatus: z.enum(['PENDING', 'INDEXED', 'FAILED']), createdAt: iso, updatedAt: iso,
}).strict()
const review = z.object({
  id: z.string(), title: z.string(), triggerType: z.enum(['CANDIDATE', 'USER_FEEDBACK', 'LIFECYCLE', 'SOURCE_CHANGE']),
  reviewType: z.enum(['NEW', 'UPDATE', 'CONFLICT', 'STALE']), candidateId: z.string().optional(), targetKnowledgeId: z.string().optional(),
  risk: z.enum(['LOW', 'MEDIUM', 'HIGH']), currentSnapshot: z.string().optional(), proposedContent: z.string().optional(),
  aiSuggestion: z.string().optional(), reviewerId: z.string(), status: z.enum(['PENDING', 'RESOLVED', 'CANCELLED']),
  resolutionAction: z.enum(['CREATE_KNOWLEDGE', 'UPDATE_KNOWLEDGE', 'KEEP_CURRENT', 'REJECT_CANDIDATE', 'ARCHIVE_KNOWLEDGE', 'CONFIRM_VALID']).optional(),
  finalContent: z.string().optional(), decisionComment: z.string().optional(), conversationId: z.string().optional(),
  feedbackType: z.enum(['WRONG', 'OUTDATED', 'MISSING', 'CITATION_ERROR', 'OTHER']).optional(), feedbackText: z.string().optional(),
  createdAt: iso, dueAt: iso.optional(), resolvedAt: iso.optional(),
}).strict()
const conversation = z.object({
  id: z.string(), title: z.string(), userId: z.string(), topic: z.string().optional(), scope: z.enum(['ENTERPRISE', 'SESSION', 'BOTH']),
  summary: z.string().optional(), sessionAssetIds: z.array(z.string()), status: z.enum(['ACTIVE', 'ARCHIVED']), messageCount: z.number().int().nonnegative(),
  negativeFeedbackCount: z.number().int().nonnegative(), hasOpenIssue: z.boolean(), lastFeedbackType: z.enum(['WRONG', 'OUTDATED', 'MISSING', 'CITATION_ERROR', 'OTHER']).optional(),
  lastFeedbackText: z.string().optional(), createdAt: iso, lastActiveAt: iso,
}).strict()
const message = z.object({
  id: z.string(), conversationId: z.string(), role: z.enum(['USER', 'ASSISTANT']), text: z.string(), createdAt: iso,
  citations: z.array(z.object({ knowledgeId: z.string(), title: z.string(), assetId: z.string(), locator: z.string(), excerpt: z.string() }).strict()),
  feedback: z.object({ helpful: z.boolean(), type: z.enum(['WRONG', 'OUTDATED', 'MISSING', 'CITATION_ERROR', 'OTHER']).optional(), text: z.string().optional(), createdAt: iso }).strict().optional(),
}).strict()

export const platformSnapshotSchema = z.object({
  version: z.literal(1),
  session: z.object({ userId: z.string(), role: z.enum(['EMPLOYEE', 'OWNER', 'ADMIN']) }).strict(),
  users: z.array(z.object({ id: z.string(), name: z.string(), role: z.enum(['EMPLOYEE', 'OWNER', 'ADMIN']) }).strict()),
  assets: z.array(asset), candidates: z.array(candidate), knowledge: z.array(knowledge), reviews: z.array(review),
  conversations: z.array(conversation), messages: z.array(message),
  assetInputs: z.record(z.string(), z.object({ content: z.string(), mimeType: z.string() }).strict()),
}).strict()

export function parseSnapshot(input: unknown): PlatformSnapshot {
  const result = platformSnapshotSchema.safeParse(input)
  if (!result.success) throw new Error('INVALID_DATA_FILE')
  return result.data
}
```

- [ ] **步骤 4：实现规则函数**

`shared/domain/rules.ts`：

```ts
import type { Authority, IndexStatus, KnowledgeStatus, ResolutionAction, ReviewType } from './enums.js'

const authorityRank: Record<Authority, number> = { L0: 0, L1: 1, L2: 2, L3: 3 }
const matrix: Record<ReviewType, ResolutionAction[]> = {
  NEW: ['CREATE_KNOWLEDGE', 'REJECT_CANDIDATE'],
  UPDATE: ['UPDATE_KNOWLEDGE', 'KEEP_CURRENT', 'REJECT_CANDIDATE'],
  CONFLICT: ['CREATE_KNOWLEDGE', 'UPDATE_KNOWLEDGE', 'KEEP_CURRENT', 'REJECT_CANDIDATE'],
  STALE: ['UPDATE_KNOWLEDGE', 'CONFIRM_VALID', 'ARCHIVE_KNOWLEDGE'],
}

export const allowedReviewActions = (type: ReviewType) => [...matrix[type]]
export const canAnswerWithKnowledge = (value: { status: KnowledgeStatus; aiEnabled: boolean; indexStatus: IndexStatus }) =>
  value.status === 'ACTIVE' && value.aiEnabled && value.indexStatus === 'INDEXED'

export function validateKnowledgeAuthority(knowledge: Authority, source: Authority) {
  if (authorityRank[knowledge] > authorityRank[source]) throw new Error('KNOWLEDGE_AUTHORITY_EXCEEDS_SOURCE')
}

export function assertReviewAction(type: ReviewType, action: ResolutionAction) {
  if (!matrix[type].includes(action)) throw new Error('REVIEW_ACTION_NOT_ALLOWED')
}
```

- [ ] **步骤 5：运行测试并提交**

```bash
npm run test:run -- shared/domain/rules.test.ts
npm run typecheck
git add shared
git commit -m "feat: define knowledge platform domain rules"
```

预期：领域测试全部通过，类型检查无错误。

## 任务 4：实现原子 JSON Repository 和 API 骨架

**文件：**

- 创建：`server/application/ports.ts`
- 创建：`server/adapters/jsonRepository.ts`
- 创建：`server/seed.ts`
- 创建：`server/app.ts`
- 修改：`server/index.ts`
- 测试：`server/tests/jsonRepository.test.ts`

- [ ] **步骤 1：写 Repository 失败测试**

测试必须使用 `mkdtemp` 创建独立目录，验证：首次读取写入 seed、事务后重载一致、无效 JSON 抛出 `INVALID_DATA_FILE`、写入不会留下临时文件。

```ts
it('事务写入后可以从新实例完整读回', async () => {
  const first = new JsonRepository(file, seedSnapshot())
  await first.transact((draft) => { draft.session.role = 'ADMIN' })
  const second = new JsonRepository(file, seedSnapshot())
  expect((await second.read()).session.role).toBe('ADMIN')
})
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`npm run test:run -- server/tests/jsonRepository.test.ts`

预期：FAIL，Repository 不存在。

- [ ] **步骤 3：实现 Repository 端口和原子适配器**

`server/application/ports.ts`：

```ts
import type { PlatformSnapshot } from '../../shared/domain/models.js'

export interface PlatformRepository {
  read(): Promise<PlatformSnapshot>
  transact<T>(mutator: (draft: PlatformSnapshot) => T | Promise<T>): Promise<T>
}
```

`server/adapters/jsonRepository.ts`：

```ts
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { PlatformSnapshot } from '../../shared/domain/models.js'
import { parseSnapshot } from '../../shared/domain/schema.js'
import type { PlatformRepository } from '../application/ports.js'

export class JsonRepository implements PlatformRepository {
  private cache?: PlatformSnapshot
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private file: string, private seed: PlatformSnapshot) {}

  private async load() {
    if (this.cache) return this.cache
    try {
      this.cache = parseSnapshot(JSON.parse(await readFile(this.file, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.cache = parseSnapshot(structuredClone(this.seed))
      await this.persist(this.cache)
    }
    return this.cache
  }

  private async persist(snapshot: PlatformSnapshot) {
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${process.pid}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
      await rename(temporary, this.file)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }

  async read() {
    return structuredClone(await this.load())
  }

  async transact<T>(mutator: (draft: PlatformSnapshot) => T | Promise<T>): Promise<T> {
    const operation = this.queue.then(async () => {
      const current = await this.load()
      const draft = structuredClone(current)
      const result = await mutator(draft)
      const validated = parseSnapshot(draft)
      await this.persist(validated)
      this.cache = validated
      return result
    })
    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }
}
```

任何异常不更新内存快照；同一进程内的写入按队列串行执行。

- [ ] **步骤 4：建立可注入的 Fastify 应用**

`server/app.ts`：

```ts
import Fastify from 'fastify'
import type { PlatformRepository } from './application/ports.js'

export function buildApp(repository: PlatformRepository) {
  const app = Fastify()
  app.get('/api/health', async () => ({ ok: true, provider: 'local-json' }))
  app.setErrorHandler((error, _request, reply) => {
    const code = error.message || 'INTERNAL_ERROR'
    reply.status(code === 'FORBIDDEN' ? 403 : 400).send({ error: { code, message: code, details: {} } })
  })
  return app
}
```

`server/index.ts` 创建 `data/knowledge-platform.json` 的 Repository 并传入 `buildApp`。`server/seed.ts` 提供三名用户和空业务集合，不在每次启动时覆盖现有数据。

- [ ] **步骤 5：运行测试并提交**

```bash
npm run test:run -- server/tests/jsonRepository.test.ts
npm run typecheck
git add server shared/domain/models.ts data/.gitkeep
git commit -m "feat: add atomic local repository"
```

## 任务 5：完成 Asset → Candidate 纵向切片

**文件：**

- 创建：`server/adapters/deterministicAi.ts`
- 创建：`server/adapters/localRetrieval.ts`
- 创建：`server/application/assetService.ts`
- 创建：`server/routes/assetRoutes.ts`
- 修改：`server/app.ts`
- 测试：`server/tests/assetFlow.test.ts`

- [ ] **步骤 1：写端到端失败测试**

测试通过 Fastify `inject` 创建 UTF-8 文本 Asset，调用 process，断言：

```ts
expect(asset.processStatus).toBe('PROCESSED')
expect(asset.contentHash).toMatch(/^[a-f0-9]{64}$/)
expect(detail.candidates[0].sourceExcerpt).toContain('私有化部署')
expect(detail.candidates[0].authority).toBe(asset.authority)
expect(detail.candidates[0].relation).toBe('NEW')
expect(detail.reviews).toHaveLength(1)
```

另写失败用例：不支持的二进制文件进入 FAILED，保留 `errorMessage='UNSUPPORTED_BINARY_FORMAT'`，不产生 Candidate；完全重复且置信度至少 0.90 的 Candidate 自动 REJECTED 且不创建 Review；低置信度 DUPLICATE 仍创建 Review。

- [ ] **步骤 2：运行测试并确认失败**

运行：`npm run test:run -- server/tests/assetFlow.test.ts`

预期：FAIL，Asset 路由和服务不存在。

- [ ] **步骤 3：实现确定性处理、提取和比较**

确定性适配器规则固定为：按空行/句号分段；含“支持”“必须”“不得”“最低”的句子成为 Candidate；标题取前 32 个字符；类型按关键词映射；与规范化内容完全相同的 ACTIVE Knowledge 判为 DUPLICATE，否则为 NEW。测试 fixture 明确包含 UPDATE 和 CONFLICT 标记句，用于后续流程，不调用外部模型。

`AssetService.process(id)` 必须在一个应用操作中完成：PROCESSING、解析、hash、sections、Candidates、Review 路由、PROCESSED；异常时单独事务写 FAILED 和错误信息。

- [ ] **步骤 4：实现 Asset API**

路由请求契约：

```ts
const createAssetBody = z.object({
  title: z.string().min(1).max(200),
  assetType: z.enum(['DOCUMENT', 'AUDIO', 'VIDEO', 'IMAGE']),
  businessType: z.enum(['PRODUCT_DOCUMENT', 'SOLUTION', 'POLICY', 'PROCESS', 'TRAINING', 'CUSTOMER_MEETING', 'INTERNAL_MEETING', 'PROJECT_DOCUMENT', 'SESSION_UPLOAD', 'OTHER']),
  ownerId: z.string().min(1),
  content: z.string(),
  mimeType: z.string().min(1),
  isSessionAsset: z.boolean().default(false),
})
```

实现 `GET /api/assets`、`POST /api/assets`、`GET /api/assets/:assetId`、`POST /api/assets/:assetId/process`，并让详情返回关联 Candidates 和 Reviews。

- [ ] **步骤 5：验证并提交**

```bash
npm run test:run -- server/tests/assetFlow.test.ts
npm run test:run
npm run typecheck
git add server
git commit -m "feat: process assets into reviewable candidates"
```

## 任务 6：完成 Review → Knowledge 纵向切片

**文件：**

- 创建：`server/adapters/localIndexer.ts`
- 创建：`server/application/reviewService.ts`
- 创建：`server/routes/reviewRoutes.ts`
- 创建：`server/routes/knowledgeRoutes.ts`
- 修改：`server/app.ts`
- 测试：`server/tests/reviewFlow.test.ts`

- [ ] **步骤 1：写失败测试覆盖六种裁决效果**

至少覆盖：

```ts
it('CONFLICT 可以创建新知识且不修改旧知识', async () => {
  const before = await getKnowledge(existingId)
  await resolve(reviewId, { action: 'CREATE_KNOWLEDGE', finalContent: '轻量部署可使用 2 张 A800。', decisionComment: '与标准部署属于不同场景' })
  expect((await getKnowledge(existingId)).version).toBe(before.version)
  expect((await listKnowledge()).some((item) => item.content.includes('轻量部署'))).toBe(true)
})
```

同时断言：NEW 不允许 ARCHIVE；Authority 越级返回 400；非 Reviewer 的 Owner 返回 403；已 RESOLVED 的 Review 不能重复提交；新/更新知识进入 INDEXED 后才能回答。

- [ ] **步骤 2：运行测试并确认失败**

运行：`npm run test:run -- server/tests/reviewFlow.test.ts`

预期：FAIL，Review 服务和路由不存在。

- [ ] **步骤 3：实现原子裁决服务**

`ReviewService.resolve` 在一次 Repository 事务中：加载关联对象、检查角色和矩阵、校验 finalContent、执行明确的 ResolutionAction、更新 Candidate、写 Review 历史、设置 Knowledge `indexStatus='PENDING'`。事务成功后调用 LocalIndexer；索引成功再把状态改为 INDEXED，失败改为 FAILED，不回滚审核结论。

- [ ] **步骤 4：实现 Review 与 Knowledge API**

`POST /api/reviews/:reviewId/resolve` 请求：

```ts
const resolveReviewBody = z.object({
  action: z.enum(['CREATE_KNOWLEDGE', 'UPDATE_KNOWLEDGE', 'KEEP_CURRENT', 'REJECT_CANDIDATE', 'ARCHIVE_KNOWLEDGE', 'CONFIRM_VALID']),
  finalContent: z.string().max(4000).optional(),
  decisionComment: z.string().min(1).max(2000),
})
```

实现 Review 列表/详情、Knowledge 列表/详情、request-update、reindex；列表过滤由服务端应用角色与查询参数。

- [ ] **步骤 5：验证并提交**

```bash
npm run test:run -- server/tests/reviewFlow.test.ts
npm run test:run
npm run typecheck
git add server shared
git commit -m "feat: resolve reviews into trusted knowledge"
```

## 任务 7：建立八个路由、双产品壳和演示身份

**文件：**

- 创建：`src/api/client.ts`
- 创建：`src/session/SessionProvider.tsx`
- 创建：`src/components/layout/ProductShell.tsx`
- 创建：`src/components/layout/FactoryNav.tsx`
- 创建：八个页面的占位入口文件
- 修改：`src/app/App.tsx`
- 测试：`src/app/App.test.tsx`
- 创建：`server/routes/sessionRoutes.ts`

- [ ] **步骤 1：写路由和权限失败测试**

测试 Employee 默认进入 `/chat`、看不到 “Knowledge Factory”；Owner 可以打开 `/factory`；未知路由显示 404；八个路径各有唯一 `h1`。

- [ ] **步骤 2：运行测试并确认失败**

运行：`npm run test:run -- src/app/App.test.tsx`

预期：FAIL，路由和 SessionProvider 不存在。

- [ ] **步骤 3：实现统一 API Client 与 SessionProvider**

`src/api/client.ts` 统一处理 JSON 和稳定错误结构：

```ts
export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message) }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new ApiError(body.error?.code ?? 'UNKNOWN_ERROR', body.error?.message ?? '请求失败', response.status)
  return body as T
}
```

SessionProvider 从 `/api/session` 读取当前用户；切换身份调用 `PUT /api/session/role`，成功后刷新受权限影响的数据。`POST /api/demo/reset` 仅允许 Admin 调用，用 `seedSnapshot()` 原子替换当前数据；Session API 测试同时断言 Employee 调用返回 403。

- [ ] **步骤 4：实现路由和产品壳**

`src/app/App.tsx` 路由必须与设计冻结一致：

```tsx
<Routes>
  <Route element={<ProductShell />}>
    <Route path="/" element={<Navigate to="/chat" replace />} />
    <Route path="/chat" element={<ChatPage />} />
    <Route element={<FactoryGuard />}>
      <Route path="/factory" element={<FactoryWorkbenchPage />} />
      <Route path="/factory/assets" element={<AssetListPage />} />
      <Route path="/factory/assets/:assetId" element={<AssetDetailPage />} />
      <Route path="/factory/reviews" element={<ReviewListPage />} />
      <Route path="/factory/reviews/:reviewId" element={<ReviewDetailPage />} />
      <Route path="/factory/knowledge" element={<KnowledgeListPage />} />
      <Route path="/factory/knowledge/:knowledgeId" element={<KnowledgeDetailPage />} />
    </Route>
    <Route path="*" element={<NotFoundPage />} />
  </Route>
</Routes>
```

- [ ] **步骤 5：验证并提交**

```bash
npm run test:run -- src/app/App.test.tsx
npm run build
git add src server/routes/sessionRoutes.ts server/app.ts
git commit -m "feat: add role-aware product routes"
```

## 任务 8：实现工作台、Asset 列表和证据联动详情

**文件：**

- 创建：`src/pages/FactoryWorkbenchPage.tsx`
- 创建：`src/pages/AssetListPage.tsx`
- 创建：`src/pages/AssetDetailPage.tsx`
- 创建：`src/components/ui/AsyncState.tsx`
- 测试：`src/pages/FactoryWorkbenchPage.test.tsx`
- 测试：`src/pages/AssetListPage.test.tsx`
- 测试：`src/pages/AssetDetailPage.test.tsx`

- [ ] **步骤 1：写页面失败测试**

测试工作台仅展示待审核、冲突、Stale、最近处理资产；Asset 列表不展示 hash/token；点击列表进入详情；点击 Candidate 后高亮对应 `sourceExcerpt`；FAILED Asset 显示“重新处理”。

- [ ] **步骤 2：运行测试并确认失败**

```bash
npm run test:run -- src/pages/FactoryWorkbenchPage.test.tsx src/pages/AssetListPage.test.tsx src/pages/AssetDetailPage.test.tsx
```

预期：FAIL，占位页面没有数据与交互。

- [ ] **步骤 3：实现工作台和 Asset 页面**

每页使用相同异步状态约定：`loading | ready | empty | error | forbidden`。详情页用 `selectedCandidateId` 驱动 source section 与 Candidate 双向高亮；处理按钮调用 `/api/assets/:id/process`，服务器确认后重新读取详情。

必须使用可访问结构：一个 `h1`、表格或列表具备可读列名、Candidate 使用 button、错误状态有“重新加载”按钮。

- [ ] **步骤 4：验证并提交**

```bash
npm run test:run -- src/pages/FactoryWorkbenchPage.test.tsx src/pages/AssetListPage.test.tsx src/pages/AssetDetailPage.test.tsx
npm run build
git add src/pages src/components/ui
git commit -m "feat: add factory asset workflow"
```

## 任务 9：实现 Review 与 Knowledge 管理页面

**文件：**

- 创建：`src/pages/ReviewListPage.tsx`
- 创建：`src/pages/ReviewDetailPage.tsx`
- 创建：`src/pages/KnowledgeListPage.tsx`
- 创建：`src/pages/KnowledgeDetailPage.tsx`
- 测试：`src/pages/ReviewListPage.test.tsx`
- 测试：`src/pages/ReviewDetailPage.test.tsx`
- 测试：`src/pages/KnowledgeListPage.test.tsx`
- 测试：`src/pages/KnowledgeDetailPage.test.tsx`

- [ ] **步骤 1：写审核动作与历史失败测试**

测试 HIGH 在前；NEW 不出现归档；CONFLICT 出现“创建新知识”；缺少审核意见时禁用提交；成功提交后显示版本/新知识结果；Knowledge Detail 展示主来源、支撑来源与审核历史；编辑知识创建 UPDATE Review 而不直接修改内容。

- [ ] **步骤 2：运行测试并确认失败**

运行四个页面测试，预期因占位页面失败。

- [ ] **步骤 3：实现 Review 页面**

Review Detail 根据 API 返回的 `allowedActions` 渲染按钮，不在前端复制矩阵。提交 payload 只包含选定 action、finalContent、decisionComment；请求期间禁用所有决策按钮；失败保持编辑内容；成功导航到结果 Knowledge 或下一个 Review。

- [ ] **步骤 4：实现 Knowledge 页面**

列表查询参数与 URL 同步；详情不提供直接 Save。编辑动作打开表单并调用 `request-update` 创建 Review。归档也通过 Review 流程完成。状态、Authority、Owner、Version、IndexStatus、来源和历史均可见。

- [ ] **步骤 5：验证并提交**

```bash
npm run test:run -- src/pages/ReviewListPage.test.tsx src/pages/ReviewDetailPage.test.tsx src/pages/KnowledgeListPage.test.tsx src/pages/KnowledgeDetailPage.test.tsx
npm run build
git add src/pages
git commit -m "feat: add review and knowledge workspaces"
```

## 任务 10：完成 Knowledge AI 对话、引用和来源抽屉

**文件：**

- 创建：`server/application/conversationService.ts`
- 创建：`server/routes/conversationRoutes.ts`
- 创建：`src/pages/ChatPage.tsx`
- 创建：`src/components/chat/ChatComposer.tsx`
- 创建：`src/components/chat/MessageThread.tsx`
- 创建：`src/components/chat/SourceDrawer.tsx`
- 测试：`server/tests/conversationFlow.test.ts`
- 测试：`src/pages/ChatPage.test.tsx`

- [ ] **步骤 1：写对话闭环失败测试**

服务端测试：只有 ACTIVE + aiEnabled + INDEXED 知识进入回答；STALE 和 PENDING 不出现；BOTH 合并企业知识与 ready Session Asset；消息与 Conversation 元数据分开持久化。

页面测试：空态只显示中心输入框；首轮后显示历史与消息线程；多轮顺序不丢；点击 `[1]` 打开来源抽屉；刷新后重新获取会话；上传文本文件后出现 Session Asset 与 Scope；“提交为企业资料”把 `isSessionAsset` 改为 false 并进入普通 Asset 处理流程。

- [ ] **步骤 2：运行测试并确认失败**

```bash
npm run test:run -- server/tests/conversationFlow.test.ts src/pages/ChatPage.test.tsx
```

预期：FAIL，对话服务和页面不存在。

- [ ] **步骤 3：实现本地检索和确定性回答**

LocalRetrieval 对问题和 Knowledge title/content 做规范化词项匹配，按 Authority、词项覆盖率和更新时间稳定排序；只返回满足 `canAnswerWithKnowledge` 且当前角色有权限的数据。无结果返回固定“没有足够可靠资料”状态，不让生成器编造结论。

AnswerGenerator 将前 3 条证据生成简洁回答，并返回：

```ts
interface AnswerPayload {
  text: string
  confidence: 'SUPPORTED' | 'INSUFFICIENT' | 'CONFLICTING'
  citations: Array<{ knowledgeId: string; title: string; assetId: string; locator: string; excerpt: string }>
}
```

- [ ] **步骤 4：实现 Chat API 与页面**

对话 API 完成创建、列表、详情、追加消息、归档。文本/Markdown 附件通过 Asset API 创建 `SESSION_UPLOAD + L0` 的 Session Asset，处理成功后才进入 SESSION/BOTH Context；不支持的附件显示失败且不进入回答。回答完成后一次性持久化 user/assistant 消息并更新 Conversation 计数。Chat 页面采用左历史、中线程、右抽屉；移动端来源抽屉覆盖全宽；Composer 显示 Scope 和附件状态；“提交为企业资料”要求选择 BusinessType 和 Owner 后再取消 Session 标记并重新处理。

- [ ] **步骤 5：验证并提交**

```bash
npm run test:run -- server/tests/conversationFlow.test.ts src/pages/ChatPage.test.tsx
npm run test:run
npm run build
git add server src
git commit -m "feat: add cited enterprise knowledge chat"
```

## 任务 11：完成负反馈 → Review → 修复闭环

**文件：**

- 修改：`server/application/conversationService.ts`
- 修改：`server/routes/conversationRoutes.ts`
- 修改：`src/components/chat/MessageThread.tsx`
- 修改：`src/pages/ChatPage.tsx`
- 修改：`server/tests/conversationFlow.test.ts`
- 修改：`src/pages/ChatPage.test.tsx`

- [ ] **步骤 1：写失败测试**

断言 OUTDATED 反馈定位 Citation Knowledge，创建 `triggerType=USER_FEEDBACK`、`reviewType=STALE` 的 Review；Conversation 负反馈数加一并 `hasOpenIssue=true`；无 Citation 的反馈只标记 open issue，不创建虚假 Review；Review 解决后 `hasOpenIssue` 在没有其他待办时恢复 false。

- [ ] **步骤 2：运行测试并确认失败**

运行 Conversation 服务端与 Chat 页面测试，预期反馈行为失败。

- [ ] **步骤 3：实现反馈服务与 UI**

👍 直接记录 `HELPFUL`。👎 打开五选一表单：答案错误、信息过期、资料缺失、引用问题、其他；补充说明选填。提交成功显示“感谢反馈”，不向 Employee 暴露 Review ID。服务端按设计映射 Review，并防止同一 message + feedbackType 重复创建 Review。

- [ ] **步骤 4：验证完整修复闭环并提交**

```bash
npm run test:run -- server/tests/conversationFlow.test.ts src/pages/ChatPage.test.tsx
npm run test:run
git add server src
git commit -m "feat: route answer feedback into knowledge repair"
```

## 任务 12：完成视觉系统、响应式和统一页面状态

**文件：**

- 创建：`src/styles/tokens.css`
- 创建：`src/styles/global.css`
- 修改：`src/main.tsx`
- 修改：所有页面与布局组件，仅限可访问性和响应式所需内容
- 测试：`src/app/Accessibility.test.tsx`

- [ ] **步骤 1：写可访问性与结构失败测试**

断言：每页只有一个 h1；主导航有名称；所有表单控件有 label；焦点可见；dialog/drawer 有名称与关闭按钮；Employee 权限页不泄露资源标题；按钮加载时尺寸不变。

- [ ] **步骤 2：实现设计令牌与全局规则**

`tokens.css` 使用中性底色、白色工作面、深色文字、克制青绿色主操作、琥珀提示和红色风险；圆角上限 8px；所有标题与正文 `letter-spacing: 0`；不使用渐变、超大标题、装饰性图标或无功能说明文字。

`global.css` 提供可见 focus、稳定按钮高度、Skeleton、Empty、Error、Permission、Toast 和 Drawer 基础样式。断点为 1120、900、640px；表格在 640px 下转成记录行，不产生水平滚动。

- [ ] **步骤 3：逐页检查并运行测试**

```bash
npm run test:run -- src/app/Accessibility.test.tsx
npm run test:run
npm run build
```

预期：可访问性结构、全量测试和生产构建全部通过。

- [ ] **步骤 4：提交视觉与响应式完成态**

```bash
git add src
git commit -m "feat: polish responsive knowledge platform UI"
```

## 任务 13：完整验证、恢复演练与交付

**文件：**

- 修改：`README.md`
- 创建：`.env.example`
- 验证：全部源码、测试、文档和备份

- [ ] **步骤 1：编写运行与恢复说明**

README 必须给出：`npm install`、`npm run dev`、`npm run test:run`、`npm run build`；演示角色；三条闭环操作路径；数据文件位置；重置方式；备份路径与恢复命令；V1 非目标。

`.env.example` 只包含：

```dotenv
PORT=8787
DATA_FILE=./data/knowledge-platform.json
```

- [ ] **步骤 2：运行机器验证**

```bash
npm run test:run
npm run typecheck
npm run build
git status --short
```

预期：全部测试通过；类型检查和构建成功；只有 README 与 `.env.example` 等本任务文件未提交。

- [ ] **步骤 3：运行真实浏览器验证**

同时启动 Web 与 API，按顺序验证：

1. Admin 导入文本 Asset，处理后在详情看到 Candidate 与原文定位。
2. Owner 解决 NEW Review，Knowledge 变为 ACTIVE/INDEXED。
3. Employee 在 `/chat` 提问并打开 Citation 来源抽屉。
4. Employee 提交 OUTDATED 反馈。
5. Owner 在 Review 列表看到 USER_FEEDBACK/STALE 任务并更新知识。
6. Employee 再次提问，回答使用新版本。
7. 刷新页面和重启 API 后数据仍存在。
8. 在 1440×900、1024×768、390×844 三个视口检查无溢出、遮挡、跳动与控制台错误。

- [ ] **步骤 4：验证备份仍完整可读**

```bash
test -d /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase-backup-20260811
test -f /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase-backup-20260811/package.json
du -sh /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase-backup-20260811
```

预期：备份目录和旧 `package.json` 仍存在，大小与任务 1 验证记录一致。

- [ ] **步骤 5：提交交付文档并检查历史**

```bash
git add README.md .env.example
git commit -m "docs: add local v1 runbook"
git status --short
git log --oneline --decorate -12
```

预期：工作区干净；提交历史能看出基础、领域、资产、审核、Chat、反馈、视觉与文档的独立阶段。
