# React 问答与 SessionAsset 联合推理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有浅蓝色 React 中文界面接入统一 FastAPI，实现仅正式知识问答、临时资料任务分析、联合推理、双来源引用、反馈闭环和底部固定输入框。

**Architecture:** FastAPI 保存 Conversation/Message/SessionAsset 元数据，MinIO/Milvus 的 `session_documents` 空间按用户、会话和过期时间强制过滤。问答 orchestrator 先计算飞书 `allowed_policy_ids`，再按三种业务范围检索；临时资料是任务输入，正式 KnowledgeVersion 才能证明企业能力。React 使用稳定 REST + SSE 客户端替换旧 Fastify API，但保留当前路由、中文页面和布局。

**Tech Stack:** React 18、TypeScript、Vite、Vitest、Testing Library、FastAPI、Pydantic、SQLAlchemy、PostgreSQL、MinIO、Milvus、Yuxi Agent/Run SSE、OpenAI-compatible models、Docker Compose。

---

## 文件结构

后端位于 `KnowledgeBase-Yuxi`，前端位于当前 `KnowledgeBase`：

```text
KnowledgeBase-Yuxi/backend/
├── alembic/versions/20260812_0004_chat_session_assets.py
├── package/yuxi/chat_product/
│   ├── __init__.py
│   ├── models.py
│   ├── schemas.py
│   ├── repository.py
│   ├── attachment_security.py
│   ├── session_asset_service.py
│   ├── retrieval_service.py
│   ├── answer_service.py
│   ├── citation_service.py
│   ├── feedback_service.py
│   └── jobs.py
├── server/routers/product_chat_router.py
├── server/routers/citation_router.py
└── test/{unit,integration,e2e}/chat_product/

KnowledgeBase/
├── shared/api/
│   └── contracts.ts
├── src/api/
│   ├── client.ts
│   ├── auth.ts
│   ├── governance.ts
│   └── chat.ts
├── src/session/SessionProvider.tsx
├── src/pages/
│   ├── ChatPage.tsx
│   ├── AssetListPage.tsx
│   ├── AssetDetailPage.tsx
│   ├── ReviewListPage.tsx
│   ├── ReviewDetailPage.tsx
│   ├── KnowledgeListPage.tsx
│   └── KnowledgeDetailPage.tsx
├── src/components/chat/
│   ├── ChatComposer.tsx
│   ├── MessageThread.tsx
│   └── SourceDrawer.tsx
└── src/styles/app.css
```

### Task 1: 建立 Conversation、Message、SessionAsset 和 Feedback 数据结构

**Files:**
- Create: `backend/package/yuxi/chat_product/__init__.py`
- Create: `backend/package/yuxi/chat_product/models.py`
- Modify: `backend/alembic/env.py`
- Create: `backend/alembic/versions/20260812_0004_chat_session_assets.py`
- Test: `backend/test/integration/chat_product/test_chat_migration.py`

- [ ] **Step 1: 写失败迁移测试**

测试迁移后存在 `product_conversations,product_messages,session_assets,knowledge_submissions,message_citations,message_feedback`；检查 SessionAsset 有 `owner_uid,conversation_id,expires_at,deleted_at` 且不存在 `authority` 或 `current_revision_id`；Message 保存 `answer_status` 和当时使用的 knowledge version IDs。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && uv run pytest test/integration/chat_product/test_chat_migration.py -m integration -v`

Expected: FAIL，表不存在。

- [ ] **Step 3: 定义聊天产品模型**

所有模型继承定制 `GovernanceBase`；`owner_uid` 以 `String(64)` 保存并由 Repository 校验 Yuxi 用户存在，不创建跨 metadata 外键：

```text
product_conversations:
  id, owner_uid, title, scope(ENTERPRISE|SESSION|COMBINED),
  status(ACTIVE|ARCHIVED), created_at, updated_at

product_messages:
  id, conversation_id(FK), role(USER|ASSISTANT), content,
  answer_status(SUPPORTED|INSUFFICIENT|CONFLICTING nullable),
  used_knowledge_version_ids(JSON), model_version, prompt_version,
  created_at

session_assets:
  id, owner_uid, conversation_id(FK), filename, mime_type, size_bytes,
  content_hash, raw_object_key, parsed_object_key, status(UPLOADING|PARSING|READY|FAILED|EXPIRED|DELETED),
  error_code, error_message, expires_at, deleted_at, created_at, updated_at

knowledge_submissions:
  id, session_asset_id(FK), submitter_uid, owner_uid, comment,
  status(OPEN|WAITING_FOR_FEISHU|LINKED|CANCELLED), linked_asset_id(FK nullable),
  created_at, linked_at, cancelled_at
  UNIQUE(session_asset_id)

message_citations:
  id, message_id(FK), kind(REQUIREMENT_SOURCE|ENTERPRISE_EVIDENCE),
  session_asset_id(FK nullable), knowledge_version_id(FK nullable),
  source_revision_id(FK nullable), locator, excerpt, created_at

message_feedback:
  id, message_id(FK), owner_uid, feedback_type,
  comment, created_review_id(FK nullable), created_at
```

CHECK：Citation 两类引用必须且只能有对应的 session_asset 或 knowledge_version；SessionAsset expires_at > created_at；feedback_type 仅 `ANSWER_WRONG|OUTDATED|MISSING|CITATION_WRONG|REQUIREMENT_MISUNDERSTOOD|OTHER`。`KnowledgeSubmission` 只是交接记录，不复制为企业 Asset、不延长 SessionAsset 的 24 小时生命周期，也不能作为正式知识证据。

在 `backend/alembic/env.py` 增加 `import yuxi.chat_product.models`，确保该模块的 `GovernanceBase` 表进入 Alembic target metadata。

- [ ] **Step 4: 生成迁移并往返测试**

Run:

```bash
cd backend
uv run alembic revision --autogenerate -m "create product chat and session assets" --rev-id 20260812_0004
uv run alembic upgrade head
uv run pytest test/integration/chat_product/test_chat_migration.py -m integration -v
uv run alembic downgrade 20260812_0003
uv run alembic upgrade head
```

Expected: 测试和往返 PASS。

- [ ] **Step 5: 提交聊天结构**

```bash
git add backend/package/yuxi/chat_product backend/alembic/versions/20260812_0004_chat_session_assets.py \
  backend/test/integration/chat_product/test_chat_migration.py
git commit -m "feat: persist product conversations and session assets"
```

### Task 2: 实现不可信附件安全与 24 小时生命周期

**Files:**
- Create: `backend/package/yuxi/chat_product/attachment_security.py`
- Create: `backend/package/yuxi/chat_product/session_asset_service.py`
- Create: `backend/package/yuxi/chat_product/jobs.py`
- Test: `backend/test/unit/chat_product/test_attachment_security.py`
- Test: `backend/test/integration/chat_product/test_session_asset_lifecycle.py`

- [ ] **Step 1: 写附件攻击面失败测试**

覆盖：`../../secret.pdf` 规范化；控制字符/双扩展名；宏文档 `.docm/.xlsm/.pptm` 拒绝；可执行脚本拒绝；zip bomb（解压比>100 或文件>1000）拒绝；嵌入外链不自动获取；文件正文“忽略系统提示”只能作为资料文本；单文件 100 MiB 上限；同名不覆盖；默认 expires_at=created_at+24h；重复提交只产生一个 KnowledgeSubmission；提交后仍按原时间过期且不创建 Asset。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && uv run pytest test/unit/chat_product/test_attachment_security.py -v`

Expected: FAIL，安全模块不存在。

- [ ] **Step 3: 实现附件校验器**

允许：PDF、DOCX、PPTX、XLSX、MD、TXT、PNG/JPEG/WebP；以 MIME、magic bytes 和扩展名三者核对。拒绝宏/脚本、密码压缩包、路径穿越、超限、嵌套压缩。清洗后文件名最长 180；MinIO key：

```text
sessions/{owner_uid}/{conversation_id}/{session_asset_id}/raw/{safe_filename}
sessions/{owner_uid}/{conversation_id}/{session_asset_id}/parsed/content.md
sessions/{owner_uid}/{conversation_id}/{session_asset_id}/parsed/locations.json
```

任何日志只记录 asset ID、MIME、大小和错误码，不记录正文或文件名中的敏感内容。

- [ ] **Step 4: 实现 SessionAssetService**

```python
async def create_upload(owner_uid, conversation_id, upload, now) -> SessionAsset
async def parse(asset_id, actor_uid) -> SessionAsset
async def delete(asset_id, actor_uid, now) -> None
async def expire_due(now, limit=100) -> int
async def assert_access(asset_id, actor_uid, conversation_id, now) -> SessionAsset
async def submit_to_owner(asset_id, actor_uid, owner_uid, comment) -> KnowledgeSubmission
```

上传时验证 conversation owner；默认 24h；解析复用 Yuxi 普通文档/RapidOCR；写入 `session_documents` collection 时强制 metadata：`owner_uid,conversation_id,session_asset_id,expires_at`。不创建企业 Asset/Candidate/Review。删除/过期先在 PostgreSQL 标记，再删除 Milvus/MinIO；删除失败由 Job 重试，但检索立即拒绝。

`submit_to_owner` 要求 READY 且未过期，创建唯一 `KnowledgeSubmission(status=OPEN)` 并通知 Knowledge Owner。由于第一阶段飞书连接严格只读，负责人必须把经确认的原始资料人工放入受控飞书目录；同步出正式 `Asset(provider=FEISHU_WIKI)` 后，负责人把 Submission 链接到该 Asset，随后才走 Revision→Candidate→Review→Knowledge。提交动作本身不改变 SessionAsset 生命周期，也不允许直接发布。

- [ ] **Step 5: 注册清理 Job 和周期扫描**

注册 `PARSE_SESSION_ASSET`、`DELETE_SESSION_ASSET`、`EXPIRE_SESSION_ASSETS`；ARQ 每 15 分钟扫描已到期记录。重复执行不报错；过期附件的旧 Message/Citation 元数据保留，但引用解析返回 `410 SESSION_ASSET_EXPIRED`。

- [ ] **Step 6: 运行安全与生命周期测试**

Run:

```bash
cd backend
uv run pytest test/unit/chat_product/test_attachment_security.py -v
uv run pytest test/integration/chat_product/test_session_asset_lifecycle.py -m integration -v
```

Expected: 全部 PASS。

- [ ] **Step 7: 提交 SessionAsset**

```bash
git add backend/package/yuxi/chat_product/attachment_security.py backend/package/yuxi/chat_product/session_asset_service.py \
  backend/package/yuxi/chat_product/jobs.py backend/test/unit/chat_product/test_attachment_security.py \
  backend/test/integration/chat_product/test_session_asset_lifecycle.py
git commit -m "feat: isolate expiring session assets"
```

### Task 3: 实现三种问答范围与检索前 ACL

**Files:**
- Create: `backend/package/yuxi/chat_product/schemas.py`
- Create: `backend/package/yuxi/chat_product/repository.py`
- Create: `backend/package/yuxi/chat_product/retrieval_service.py`
- Test: `backend/test/unit/chat_product/test_retrieval_service.py`
- Test: `backend/test/integration/chat_product/test_retrieval_acl.py`

- [ ] **Step 1: 写检索范围失败测试**

矩阵：ENTERPRISE 只调 formal；SESSION 只调 session；COMBINED 两者均调；formal 前先取 allowed policy IDs；空 policy 不调用 Milvus；session filter 同时含 owner/conversation/not-expired；跨用户、跨会话和过期均无结果；Section/Candidate collection 从不被调用；ACL 服务异常返回空 formal 结果而非沿用缓存。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && uv run pytest test/unit/chat_product/test_retrieval_service.py -v`

Expected: FAIL，retrieval service 不存在。

- [ ] **Step 3: 定义稳定问答 Schema**

```python
class ConversationScope(StrEnum):
    ENTERPRISE = "ENTERPRISE"
    SESSION = "SESSION"
    COMBINED = "COMBINED"


class AnswerStatus(StrEnum):
    SUPPORTED = "SUPPORTED"
    INSUFFICIENT = "INSUFFICIENT"
    CONFLICTING = "CONFLICTING"


class CitationKind(StrEnum):
    REQUIREMENT_SOURCE = "REQUIREMENT_SOURCE"
    ENTERPRISE_EVIDENCE = "ENTERPRISE_EVIDENCE"


class ChatMessageRequest(BaseModel):
    content: str = Field(min_length=1, max_length=20000)
    scope: ConversationScope
    session_asset_ids: list[str] = Field(default_factory=list, max_length=20)
```

- [ ] **Step 4: 实现 RetrievalService**

```python
async def retrieve(query, actor, conversation, scope, session_asset_ids) -> RetrievalBundle:
    formal = []
    session = []
    if scope in {ENTERPRISE, COMBINED}:
        policy_ids = await acl.allowed_policy_ids(actor.identity)
        if policy_ids:
            formal = await formal_index.search(query, policy_ids=policy_ids, limit=12)
    if scope in {SESSION, COMBINED}:
        assets = await assert_all_session_assets(actor.uid, conversation.id, session_asset_ids)
        session = await session_index.search(
            query, owner_uid=actor.uid, conversation_id=conversation.id,
            asset_ids=[a.id for a in assets], not_expired_at=clock.now(), limit=20,
        )
    return RetrievalBundle(formal=formal, session=session)
```

正式检索返回后再从 PostgreSQL 验证 Knowledge/Version/VersionIndex/VersionAccessProjection/Policy 当前可用；任何版本不一致丢弃该条并触发高优先级投影修复 Job。

- [ ] **Step 5: 运行检索和 ACL 集成测试**

Run:

```bash
cd backend
uv run pytest test/unit/chat_product/test_retrieval_service.py -v
uv run pytest test/integration/chat_product/test_retrieval_acl.py -m integration -v
```

Expected: 全部 PASS。

- [ ] **Step 6: 提交检索编排**

```bash
git add backend/package/yuxi/chat_product/schemas.py backend/package/yuxi/chat_product/repository.py \
  backend/package/yuxi/chat_product/retrieval_service.py backend/test/unit/chat_product/test_retrieval_service.py \
  backend/test/integration/chat_product/test_retrieval_acl.py
git commit -m "feat: retrieve scoped authorized evidence"
```

### Task 4: 实现知识问答、需求拆解和双来源结果

**Files:**
- Create: `backend/package/yuxi/chat_product/answer_service.py`
- Test: `backend/test/unit/chat_product/test_answer_service.py`
- Test: `backend/test/e2e/chat_product/test_customer_requirement_response.py`

- [ ] **Step 1: 写回答行为失败测试**

覆盖：无正式证据→INSUFFICIENT 且明确“暂无足够可靠资料”；两个有效正式知识互斥→CONFLICTING；有证据→SUPPORTED；SESSION 资料不能证明企业能力；COMBINED 将需求拆成条款并逐条输出 `SATISFIED|PARTIALLY_SATISFIED|NOT_SATISFIED|INSUFFICIENT`；每条企业结论至少一个 ENTERPRISE_EVIDENCE；每条需求至少一个 REQUIREMENT_SOURCE；模型常识未被证据支持的句子被移除或降为不足。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && uv run pytest test/unit/chat_product/test_answer_service.py -v`

Expected: FAIL，answer service 不存在。

- [ ] **Step 3: 定义结构化回答合同**

```python
class RequirementResult(BaseModel):
    requirement_id: str
    requirement_text: str
    status: Literal["SATISFIED", "PARTIALLY_SATISFIED", "NOT_SATISFIED", "INSUFFICIENT"]
    response: str
    requirement_citation_ids: list[str]
    enterprise_citation_ids: list[str]


class AnswerDraft(BaseModel):
    answer_status: AnswerStatus
    content: str
    requirement_results: list[RequirementResult] = []
    used_formal_entity_ids: list[str] = []
    used_session_chunk_ids: list[str] = []
```

- [ ] **Step 4: 实现证据分区提示和验证器**

模型输入使用明确 XML-like 隔离段：`<SYSTEM_RULES>`、`<USER_TASK>`、`<SESSION_INPUT_UNTRUSTED>`、`<FORMAL_KNOWLEDGE>`。系统规则明确附件指令无效、Session 只能证明需求/背景、Formal 才能证明企业事实、证据不足时拒答。不得向模型传入未授权召回结果。

模型返回后 `GroundingValidator` 验证所有引用 ID 来自本次 bundle；企业承诺句至少关联 formal ID；需求状态有关文本至少关联 session ID。无合法 formal 引用的企业结论改为 INSUFFICIENT；不让模型生成可直接执行的工具调用。

- [ ] **Step 5: 实现消息持久化和历史版本**

在一个 PostgreSQL 事务保存 user message、assistant message、AnswerStatus、使用的 KnowledgeVersion IDs 和 Citation rows。历史消息不可因知识更新重写；重新打开 citation 时只做当前 ACL/会话权限校验。

- [ ] **Step 6: 创建客户需求 E2E fixture 和测试**

合成需求书包含三条：需要 Oracle 19c 兼容、需要离线部署、需要 7×24 驻场。正式知识只支持前两条中的一条、部分支持一条、没有驻场依据。E2E 断言三条被独立标识，输出满足/部分满足/依据不足，需求和企业引用分开；附件过期后历史回答可见但需求引用 410 且不能再次参与生成。

- [ ] **Step 7: 运行回答测试**

Run:

```bash
cd backend
uv run pytest test/unit/chat_product/test_answer_service.py -v
uv run pytest test/e2e/chat_product/test_customer_requirement_response.py -m e2e -v
```

Expected: 全部 PASS。

- [ ] **Step 8: 提交回答服务**

```bash
git add backend/package/yuxi/chat_product/answer_service.py backend/test/unit/chat_product/test_answer_service.py \
  backend/test/e2e/chat_product/test_customer_requirement_response.py backend/test/fixtures/chat_product
git commit -m "feat: answer with formal and task evidence"
```

### Task 5: 实现会话、SSE、附件和引用 API

**Files:**
- Create: `backend/server/routers/product_chat_router.py`
- Create: `backend/package/yuxi/chat_product/citation_service.py`
- Create: `backend/server/routers/citation_router.py`
- Modify: `backend/server/routers/__init__.py`
- Test: `backend/test/unit/chat_product/test_chat_router.py`
- Test: `backend/test/unit/chat_product/test_citation_service.py`

- [ ] **Step 1: 写 API 契约失败测试**

断言飞书登录必需；conversation 仅 owner；上传 multipart；提交资料只创建 KnowledgeSubmission 且要求负责人/意见；COMBINED 默认可由前端选择；SSE 事件顺序 `message.created -> run.started -> answer.delta* -> citations -> answer.completed`；断线携带 Last-Event-ID 可续读；引用打开会再校验当前 ACL/SessionAsset；过期 410；撤权 403；响应不返回 MinIO key/Milvus ID/模型提示。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && uv run pytest test/unit/chat_product/test_chat_router.py test/unit/chat_product/test_citation_service.py -v`

Expected: FAIL，路由和引用服务不存在。

- [ ] **Step 3: 实现产品聊天 API**

```text
GET    /api/chat/conversations
POST   /api/chat/conversations
GET    /api/chat/conversations/{conversation_id}
POST   /api/chat/conversations/{conversation_id}/archive
POST   /api/chat/conversations/{conversation_id}/assets       multipart
GET    /api/chat/conversations/{conversation_id}/assets/{asset_id}
DELETE /api/chat/conversations/{conversation_id}/assets/{asset_id}
POST   /api/chat/conversations/{conversation_id}/assets/{asset_id}/submit
POST   /api/chat/conversations/{conversation_id}/messages
GET    /api/chat/conversations/{conversation_id}/runs/{run_id}/events
POST   /api/chat/messages/{message_id}/feedback
```

发送消息返回 `202 {run_id,message_id}`；SSE 复用 Yuxi Redis Stream，但完成消息和 citations 必须已落 PostgreSQL。Redis 事件过期后，GET events 用 PostgreSQL terminal state 返回最终 `answer.completed`，不丢业务结果。

- [ ] **Step 4: 实现引用实时校验**

```text
GET /api/citations/{citation_id}
```

`REQUIREMENT_SOURCE`：检查 `owner_uid + conversation_id + expires_at + deleted_at`，返回 session 文件显示名、locator、excerpt 和受控下载 URL。`ENTERPRISE_EVIDENCE`：先检查当前 AccessPolicy，再使用用户 OAuth token `probe_user_access` 实时验证全部 sources；任何失败 403 `ACL_UNAVAILABLE`，成功返回正式知识内容、version、飞书原链接和定位。LOCAL_SUPERADMIN 没有飞书身份时固定 403。

- [ ] **Step 5: 运行 API 测试**

Run: `cd backend && uv run pytest test/unit/chat_product/test_chat_router.py test/unit/chat_product/test_citation_service.py -v`

Expected: 全部 PASS。

- [ ] **Step 6: 提交聊天 API**

```bash
git add backend/server/routers/product_chat_router.py backend/package/yuxi/chat_product/citation_service.py \
  backend/server/routers/citation_router.py backend/server/routers/__init__.py \
  backend/test/unit/chat_product/test_chat_router.py backend/test/unit/chat_product/test_citation_service.py
git commit -m "feat: expose streaming chat and guarded citations"
```

### Task 6: 实现反馈到复核闭环

**Files:**
- Create: `backend/package/yuxi/chat_product/feedback_service.py`
- Test: `backend/test/unit/chat_product/test_feedback_service.py`

- [ ] **Step 1: 写反馈分类失败测试**

断言：ANSWER_WRONG/OUTDATED/MISSING/CITATION_WRONG 且指向企业引用时创建对应 Knowledge Owner 的 FEEDBACK Review；REQUIREMENT_MISUNDERSTOOD 且只涉及 session 时只存对话反馈；无法分类进入 ADMIN 待分类；同用户同消息同类型重复反馈幂等；修复知识不修改历史回答。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && uv run pytest test/unit/chat_product/test_feedback_service.py -v`

Expected: FAIL，feedback service 不存在。

- [ ] **Step 3: 实现反馈事务**

`submit(message_id,actor,type,comment)` 校验消息属于 actor；保存反馈。若有企业 KnowledgeVersion，创建 `ReviewType.FEEDBACK`，`target_knowledge_id` 指向当时版本的知识，`current_snapshot` 保存当时版本号；若仅 session 或 requirement misunderstanding，不创建 Candidate/企业 Review；无法判断则创建 `ADMIN_TRIAGE_FEEDBACK` Job。

- [ ] **Step 4: 运行反馈测试**

Run: `cd backend && uv run pytest test/unit/chat_product/test_feedback_service.py -v`

Expected: 全部 PASS。

- [ ] **Step 5: 提交反馈闭环**

```bash
git add backend/package/yuxi/chat_product/feedback_service.py backend/test/unit/chat_product/test_feedback_service.py
git commit -m "feat: route answer feedback to knowledge review"
```

### Task 7: 建立 React API 合同并切换飞书会话

**Files:**
- Create: `shared/api/contracts.ts`
- Modify: `src/api/client.ts`
- Create: `src/api/auth.ts`
- Create: `src/api/governance.ts`
- Create: `src/api/chat.ts`
- Modify: `src/session/SessionProvider.tsx`
- Modify: `src/app/App.tsx`
- Test: `src/api/client.test.ts`
- Test: `src/session/SessionProvider.test.tsx`

- [ ] **Step 1: 写新 API 错误和会话失败测试**

测试 `ApiError` 解析 `{error:{code,message,request_id}}`；401 跳飞书 login；session 类型使用四角色；不再存在 `switchRole`；OWNER/ADMIN 保护改为 KNOWLEDGE_OWNER/ADMIN；LOCAL_SUPERADMIN 只能进入技术/系统页，不能以角色切换模拟员工。

- [ ] **Step 2: 运行前端测试确认失败**

Run:

```bash
npm run test:run -- src/api/client.test.ts src/session/SessionProvider.test.tsx src/app/App.test.tsx
```

Expected: FAIL，现有客户端仍使用旧 Fastify shape 和 `switchRole`。

- [ ] **Step 3: 定义完整 TypeScript 合同**

`shared/api/contracts.ts` 与后端 snake_case 精确一致，至少定义：`SessionUser,Page<T>,SourceRoot,SyncRun,GovernanceJob,Asset,AssetRevision,Section,Candidate,Review,Knowledge,KnowledgeVersion,VersionIndex,VersionAccessProjection,Conversation,Message,SessionAsset,KnowledgeSubmission,Citation,ChatRunEvent,ApiErrorBody` 和路线图中的稳定枚举。禁止复用旧 `shared/domain/models.ts` 作为正式 API 合同。

- [ ] **Step 4: 修改通用客户端**

`api<T>` 默认 `credentials:'include'`，只在 body 不是 FormData 时设置 JSON content-type；401 抛 `AUTH_REQUIRED`；SSE 客户端支持 `Last-Event-ID`、AbortSignal、指数重连最多 5 次；错误消息中文但保留 request_id。

- [ ] **Step 5: 实现资源客户端并切 SessionProvider**

资源客户端只封装阶段 5 已定义的 FastAPI 路径。SessionProvider 调 `/api/auth/feishu/session`；未登录显示“使用飞书登录”链接，并以当前受控路径构造 `/api/auth/feishu/login?return_to={return_path}`；移除角色切换。App guard：EMPLOYEE 只能 chat；KNOWLEDGE_OWNER/ADMIN 可 factory；ADMIN 可 sources/jobs；LOCAL_SUPERADMIN 只显示系统维护入口。

- [ ] **Step 6: 运行合同和会话测试**

Run:

```bash
npm run test:run -- src/api/client.test.ts src/session/SessionProvider.test.tsx src/app/App.test.tsx
npm run typecheck
```

Expected: 全部 PASS。

- [ ] **Step 7: 提交前端 API 切换基础**

```bash
git add shared/api/contracts.ts src/api src/session/SessionProvider.tsx src/app/App.tsx \
  src/session/SessionProvider.test.tsx src/app/App.test.tsx
git commit -m "feat: connect react session to feishu fastapi"
```

### Task 8: 接入问答、附件、SSE 和双来源引用界面

**Files:**
- Modify: `src/pages/ChatPage.tsx`
- Modify: `src/components/chat/ChatComposer.tsx`
- Modify: `src/components/chat/MessageThread.tsx`
- Modify: `src/components/chat/SourceDrawer.tsx`
- Modify: `src/styles/app.css`
- Modify: `src/pages/ChatPage.test.tsx`
- Modify: `src/components/chat/MessageThread.test.tsx`
- Modify: `src/components/chat/SourceDrawer.test.tsx`

- [ ] **Step 1: 写界面行为失败测试**

测试：三范围中文标签；上传后默认“企业知识＋当前资料”；附件 processing/ready/failed/expired/delete；“提交给知识负责人”生成交接状态而不是直接提升 Asset；SSE 增量显示；SUPPORTED/INSUFFICIENT/CONFLICTING 中文状态；需求来源与企业依据不同标签；引用 403/410 明确提示；发送中禁重复；底部输入框在长消息列表滚动时仍在 viewport；移动端按钮可触达。

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
npm run test:run -- src/pages/ChatPage.test.tsx src/components/chat/MessageThread.test.tsx src/components/chat/SourceDrawer.test.tsx
```

Expected: FAIL，现有页面仍调用旧 `/api/conversations` 与 `/api/assets`。

- [ ] **Step 3: 切换 ChatPage 数据流**

使用 `/api/chat/conversations/*`：创建会话、上传 multipart、轮询/事件显示 parse 状态、发送 202 run、读取 SSE、完成后刷新消息。新上传 READY 后设 scope=COMBINED；用户仍可选 ENTERPRISE/SESSION。过期和删除后从下一次请求 session_asset_ids 移除。

- [ ] **Step 4: 渲染回答和双来源**

MessageThread 显示回答状态和逐条需求结果。Citation button：

```text
REQUIREMENT_SOURCE -> 标签“需求来源”
ENTERPRISE_EVIDENCE -> 标签“企业依据”
```

SourceDrawer 调 `/api/citations/{id}`，显示 locator/excerpt；企业依据显示正式知识版本与“打开飞书原文”；需求来源显示文件名/页码。不要显示 Chunk、Embedding、Top-K、模型路由、policy ID 或 MinIO key。

- [ ] **Step 5: 保持底部固定输入框和浅蓝视觉**

保留现有 `.chat-composer-shell`/布局语义；CSS 使用：

```css
.chat-workspace { min-height: 0; height: 100%; display: grid; grid-template-rows: minmax(0, 1fr) auto; }
.message-scroll { min-height: 0; overflow-y: auto; }
.chat-composer-shell { position: sticky; bottom: 0; z-index: 10; background: color-mix(in srgb, #f7fbff 94%, transparent); }
.citation--requirement { --citation-accent: #64748b; }
.citation--enterprise { --citation-accent: #2563eb; }
```

分割线保持透明/低对比；不把页面改回青绿色。

- [ ] **Step 6: 运行聊天界面测试**

Run:

```bash
npm run test:run -- src/pages/ChatPage.test.tsx src/components/chat/MessageThread.test.tsx src/components/chat/SourceDrawer.test.tsx
npm run typecheck
npm run build
```

Expected: 全部 PASS；build 成功。

- [ ] **Step 7: 提交问答界面**

```bash
git add src/pages/ChatPage.tsx src/components/chat src/styles/app.css src/pages/ChatPage.test.tsx
git commit -m "feat: stream grounded chat with dual citations"
```

### Task 9: 接入资料、审核和知识治理页面

**Files:**
- Modify: `src/pages/FactoryWorkbenchPage.tsx`
- Modify: `src/pages/AssetListPage.tsx`
- Modify: `src/pages/AssetDetailPage.tsx`
- Modify: `src/pages/ReviewListPage.tsx`
- Modify: `src/pages/ReviewDetailPage.tsx`
- Modify: `src/pages/KnowledgeListPage.tsx`
- Modify: `src/pages/KnowledgeDetailPage.tsx`
- Modify: `src/components/layout/FactoryNav.tsx`
- Tests: matching `src/pages/*.test.tsx`

- [ ] **Step 1: 写治理 UI 失败测试**

测试 Asset 展示 Revision/Section/失败阶段；Review 展示原文、正式知识和 diff、强制意见、转交；Knowledge 展示不可变版本和 index 状态；Owner 只看自己；ADMIN 导航显示同步与任务；普通用户无技术参数；完成 Review 后按钮不可编辑。

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
npm run test:run -- src/pages/AssetListPage.test.tsx src/pages/AssetDetailPage.test.tsx \
  src/pages/ReviewListPage.test.tsx src/pages/ReviewDetailPage.test.tsx \
  src/pages/KnowledgeListPage.test.tsx src/pages/KnowledgeDetailPage.test.tsx
```

Expected: FAIL，页面仍绑定旧 Fastify 数据模型。

- [ ] **Step 3: 逐页切换治理客户端**

只替换数据字段、loading/error/empty 和动作调用，保留现有路由与视觉。Review complete body 使用 `action,final_content,decision_comment`；状态 409 时刷新详情并提示“任务状态已变化”。正式知识页组合 VersionIndex 状态，不允许直接编辑正文或“AI 自动发布”。将现有“将会话资料提交为企业资料”改成 `KnowledgeSubmission` 交接：显示负责人、意见和“等待放入飞书受控目录/已关联飞书资料”状态，不让前端直接把 SessionAsset 提升为 Asset。

- [ ] **Step 4: 增加 Admin 同步/任务入口**

FactoryWorkbench 加两张 Admin 卡：飞书来源（最近同步/ACL 状态/立即同步）和失败任务（NEEDS_ATTENTION/重试/取消）；第一阶段不新增复杂运维 Dashboard。Owner 看不到系统级任务。

- [ ] **Step 5: 运行治理 UI 测试与构建**

Run:

```bash
npm run test:run -- src/pages
npm run typecheck
npm run build
```

Expected: 全部 PASS。

- [ ] **Step 6: 提交治理页面接入**

```bash
git add src/pages src/components/layout/FactoryNav.tsx
git commit -m "feat: connect governance workspace to fastapi"
```

### Task 10: 阶段 5 联合验收

**Files:**
- Modify: `docs/implementation/acceptance-log.md`（Yuxi 工程）

- [ ] **Step 1: 运行后端阶段测试**

Run in Yuxi:

```bash
cd backend
uv run pytest test/unit/chat_product -v
uv run pytest test/integration/chat_product -m integration -v
uv run pytest test/e2e/chat_product/test_customer_requirement_response.py -m e2e -v
uv run ruff check package/yuxi/chat_product server/routers/product_chat_router.py server/routers/citation_router.py
```

Expected: 全部退出码 0。

- [ ] **Step 2: 运行 React 全量测试**

Run in current `KnowledgeBase`:

```bash
npm run test:run
npm run typecheck
npm run build
```

Expected: 全部退出码 0。

- [ ] **Step 3: 浏览器验收桌面和移动端**

用飞书测试员工登录：创建会话、上传需求书、看到处理进度、自动切 COMBINED、逐条回答、打开两类引用、提交反馈、提前删除附件。分别以 1440×900 和 390×844 验证；长会话滚动时输入框始终可见，抽屉和按钮可访问。

- [ ] **Step 4: 权限和过期验收**

用户 B 尝试访问用户 A 的 conversation/session citation 得 403；测试时钟推进 24h 后附件不再检索、引用 410、历史回答仍显示；撤回企业来源权限后企业 citation 403 且新回答不使用该知识。

- [ ] **Step 5: 记录阶段门禁**

在 Yuxi `acceptance-log.md` 将三范围、联合推理、双引用、反馈、跨用户隔离、24h、提示注入、固定输入框、桌面/移动逐项记 PASS。

- [ ] **Step 6: 分别提交验收记录**

Yuxi:

```bash
git add docs/implementation/acceptance-log.md
git commit -m "docs: accept product chat milestone"
```

Current React repo only if a frontend acceptance note was added:

```bash
git add docs/implementation
git commit -m "docs: record react chat acceptance"
```

Expected: 两个工作区均干净；只有阶段 5 PASS 后进入加固与切换。
