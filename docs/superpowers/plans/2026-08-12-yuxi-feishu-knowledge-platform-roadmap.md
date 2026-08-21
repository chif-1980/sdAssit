# Yuxi 飞书企业知识平台总路线图 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不破坏现有 React 原型的前提下，以固定版 Yuxi `v0.7.1` 建成单企业、单飞书租户的私有知识平台，并通过真实飞书目录、知识更新和客户需求联合推理三类验收。

**Architecture:** 当前 `KnowledgeBase` 保留 React 中文业务界面，新的同级 `KnowledgeBase-Yuxi` 承载统一 FastAPI、治理领域、飞书连接、Yuxi RAG/Agent 和后台任务。PostgreSQL 保存全部业务事实，MinIO 保存证据快照，Milvus 只保存可重建且按 `AccessPolicy` 过滤的正式知识/会话资料索引，Redis/ARQ 只负责投递与流式事件。

**Tech Stack:** React 18、TypeScript、Vite、FastAPI、Pydantic、SQLAlchemy、Alembic、PostgreSQL 16、ARQ、Redis 7、MinIO、Milvus 2.5、httpx、pytest、Vitest、Docker Compose、飞书开放平台 API、外部 OpenAI-compatible Chat/Embedding API。

---

## 0. 执行边界

本路线图只规定执行次序、阶段契约与门禁。具体 TDD 步骤分别位于六份阶段计划：

1. `docs/superpowers/plans/2026-08-12-yuxi-baseline-deployment.md`
2. `docs/superpowers/plans/2026-08-12-knowledge-governance-backend.md`
3. `docs/superpowers/plans/2026-08-12-feishu-sync-and-acl.md`
4. `docs/superpowers/plans/2026-08-12-knowledge-processing-and-publishing.md`
5. `docs/superpowers/plans/2026-08-12-react-chat-and-session-assets.md`
6. `docs/superpowers/plans/2026-08-12-hardening-and-cutover.md`

执行时遵守以下硬边界：

- Yuxi 只允许克隆到 `/Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase-Yuxi`，不得覆盖当前工程。
- 固定检出 tag `v0.7.1`；检出后记录实际 `git rev-parse HEAD`，并与批准基线 `dfb3aa203ab3d6390465d99f718e5d7fce50eecb` 比较。若上游 tag 指向不同提交，立即停止并报告，不自行选择新提交。
- `.env`、飞书应用密钥、OAuth 密钥和模型密钥不得提交、打印到终端记录或复制进计划验收报告。
- 不运行 Yuxi 的 `make reset`；该命令会删除 `docker/volumes`。需要重启时只使用 `docker compose restart` 或 `make down && make up`。
- 新系统整体验收完成前，不删除当前 `server/`、`data/`、Git 历史或现有恢复点。
- 第一阶段不实现音视频 ASR、Neo4j、多租户、本地模型、GPU 解析、自动发布、正式 Word/PDF 排版、Kubernetes 或高可用。
- 真实飞书根节点 `POFEwqvUaiwFBXkNRuScMy3inkd` 只做读取、导出、权限查询与事件接收，不回写、移动或删除原文。

## 1. 跨阶段稳定契约

### 1.1 API 资源

所有业务前端只访问同一 FastAPI，稳定前缀如下：

```text
/api/auth/feishu/*
/api/governance/sources/*
/api/governance/jobs/*
/api/governance/assets/*
/api/governance/candidates/*
/api/governance/reviews/*
/api/governance/knowledge/*
/api/chat/conversations/*
/api/citations/*
```

错误统一返回：

```json
{
  "error": {
    "code": "ACL_UNAVAILABLE",
    "message": "当前无法确认来源权限，已拒绝访问",
    "request_id": "01JEXAMPLE0000000000000000"
  }
}
```

React 端不得直接调用 Yuxi 内部知识库、Milvus、MinIO 或模型接口。

### 1.2 稳定枚举

跨计划统一使用以下值，实施中不得另造同义状态：

```text
Role: EMPLOYEE | KNOWLEDGE_OWNER | ADMIN | LOCAL_SUPERADMIN
Authority: L0 | L1 | L2 | L3
AssetProvider: FEISHU_WIKI
AssetLifecycle: ACTIVE | MOVED_OUT | DELETED | INACCESSIBLE | UNSUPPORTED
RevisionStage: DISCOVERED | FETCHING | PARSING | EXTRACTING | COMPARING | READY | FAILED
CandidateRelation: NEW | DUPLICATE | UPDATE | CONFLICT | INSUFFICIENT
CandidateStatus: PENDING_REVIEW | AUTO_CLOSED | ACCEPTED | REJECTED | INSUFFICIENT
ReviewType: CREATE | UPDATE | CONFLICT | ARCHIVE | FEEDBACK | SOURCE_CHANGE
ReviewStatus: OPEN | COMPLETED | CANCELLED
KnowledgeStatus: DRAFT | PUBLISHING | ACTIVE | STALE | ARCHIVED
IndexStatus: PENDING | INDEXED | FAILED
JobStatus: PENDING | DISPATCHED | RUNNING | RETRY_WAIT | SUCCEEDED | NEEDS_ATTENTION | CANCELLED
ConversationScope: ENTERPRISE | SESSION | COMBINED
AnswerStatus: SUPPORTED | INSUFFICIENT | CONFLICTING
CitationKind: REQUIREMENT_SOURCE | ENTERPRISE_EVIDENCE
```

数据库使用大写值；Python 枚举名与值一致；TypeScript API 类型沿用同一字符串，不在前端做二次映射。

### 1.3 业务不变量

- `AssetRevision`、`Section`、已完成 `Review` 和 `KnowledgeVersion` 只增不改；纠错产生新记录。
- `Section` 和 `Candidate` 永远不能进入普通员工问答索引。
- 只有 `Knowledge.status=ACTIVE`、`Knowledge.ai_enabled=true`、对应最新 `VersionIndex.status=INDEXED`、`VersionAccessProjection.status=VALID` 且当前 ACL 可确认时才能召回；API 将索引投影状态返回为 `KnowledgeVersion.index_status`。
- 多来源 `KnowledgeVersion` 的当前可见范围是全部来源 ACL 的交集：`AccessPolicy` 为每个来源保存一个允许 principal 子句，用户必须逐个子句都命中至少一个当前 principal，不能把不同来源的 principal 字符串直接求集合交集。
- 首次发布没有旧版本时 `Knowledge.status=PUBLISHING`；已有 ACTIVE 版本发布更新时仍保持 ACTIVE，并通过 `pending_version_id` 表示新版本正在索引，从而让旧有效版本继续回答。
- 权限无法确认、策略投影落后、来源移出/删除/撤权时默认拒绝。
- `SessionAsset` 绑定上传用户和一个会话，默认 24 小时过期；不会因上传或问答自动成为企业 `Asset`。
- 用户主动提交临时资料时只创建 `KnowledgeSubmission` 交接记录；负责人将确认后的原件人工放入只读飞书受控目录，系统同步为新的正式 Asset 后才进入完整治理链路。
- AI 只能产生候选、关系和建议；发布必须来自有意见文本的人工作业。
- PostgreSQL 是 Job/Outbox 状态事实；Redis 清空后可以重新投递，Milvus 清空后可以重建。

## 2. 阶段依赖与门禁

| 阶段 | 交付物 | 进入条件 | 退出门禁 |
| --- | --- | --- | --- |
| 1. Yuxi 基线 | 隔离的固定版 Yuxi、精简 Compose、基线验收记录 | 当前仓库干净且规格已提交 | 登录、外部模型、TXT/PDF/图片解析、Milvus 检索、带引用回答、重启持久化全部通过 |
| 2. 治理后端 | Alembic、治理模型、Job/Outbox、FastAPI 资源骨架 | 阶段 1 验收通过 | 领域不变量、迁移、事务 Outbox、Worker 重派、API 权限角色测试通过 |
| 3. 飞书与 ACL | 飞书 OAuth、Wiki 递归同步、Revision/Section、ACL 投影 | 阶段 2 验收通过 | 1000 节点模拟扫描、事件/对账、ACL 交集、撤权阻断、真实根节点只读 dry-run 通过 |
| 4. 加工发布 | 候选提取、比较、审核、版本发布、正式索引 | 阶段 3 验收通过 | Schema 三次失败转异常、AI 不可发布、索引原子切换、Q900 V1/V2 后端场景通过 |
| 5. 问答与会话资料 | React 接入、SSE、SessionAsset、联合推理、双来源引用、反馈 | 阶段 4 验收通过 | 三范围问答、24h 过期、跨用户/会话拒绝、双引用、固定输入框桌面/移动端通过 |
| 6. 加固切换 | 恢复演练、安全验收、真实目录 E2E、备份与 Fastify 停用 | 阶段 5 验收通过 | 全测试、真实飞书验收、Redis/Milvus/Worker 恢复、回退演练和书面切换确认通过 |

任何阶段退出门禁失败，只修复当前阶段，不提前实现后续业务。

## 3. 里程碑执行清单

### Task 1: 建立执行记录

**Files:**
- Create: `docs/implementation/acceptance-log.md`（位于 `KnowledgeBase-Yuxi`）
- Create: `docs/implementation/decision-log.md`（位于 `KnowledgeBase-Yuxi`）

- [ ] **Step 1: 记录固定输入**

在验收记录写入日期、操作者、Yuxi tag/commit、两个工程的绝对路径、Docker 版本、CPU/内存/磁盘信息和当前阶段。凭据只记录“已配置/未配置”，不记录值。

- [ ] **Step 2: 验证记录不含秘密**

Run:

```bash
rg -n "(secret|token|password|api[_-]?key)\s*[:=]\s*[^<$]" docs/implementation .env.example
```

Expected: 除示例变量名和脱敏说明外无命中；若命中真实值，先从 Git 工作区移除并轮换该凭据。

- [ ] **Step 3: 提交执行记录骨架**

```bash
git add docs/implementation
git commit -m "docs: initialize integration acceptance record"
```

Expected: 新提交只包含两份执行记录。

### Task 2: 顺序执行六阶段计划

**Files:**
- Read: `docs/superpowers/plans/2026-08-12-yuxi-baseline-deployment.md`
- Read: `docs/superpowers/plans/2026-08-12-knowledge-governance-backend.md`
- Read: `docs/superpowers/plans/2026-08-12-feishu-sync-and-acl.md`
- Read: `docs/superpowers/plans/2026-08-12-knowledge-processing-and-publishing.md`
- Read: `docs/superpowers/plans/2026-08-12-react-chat-and-session-assets.md`
- Read: `docs/superpowers/plans/2026-08-12-hardening-and-cutover.md`

- [ ] **Step 1: 执行阶段 1 并记录门禁**

完成阶段 1 全部复选框，把命令、退出码、容器状态和人工验收结论附到 `acceptance-log.md`。只有六项基线能力均为 PASS 才签署阶段 1。

- [ ] **Step 2: 执行阶段 2 并记录门禁**

完成治理领域、迁移和可靠任务测试。验证 PostgreSQL 停止时写接口失败且不会写入 JSON，再签署阶段 2。

- [ ] **Step 3: 执行阶段 3 并记录门禁**

先以伪造飞书响应完成自动化测试，再用真实根节点执行只读 dry-run。dry-run 必须显示节点数量与类型统计，不下载正文到验收报告。

- [ ] **Step 4: 执行阶段 4 并记录门禁**

用合成 Q900 证据完成 V1/V2 更新；验证审核前仍使用旧有效版本、审核并索引后才切到新版本。

- [ ] **Step 5: 执行阶段 5 并记录门禁**

用无敏感信息的合成客户需求书完成联合推理；需求来源只能证明客户要求，企业能力必须引用正式知识。

- [ ] **Step 6: 执行阶段 6 并记录门禁**

完成恢复、安全、浏览器和真实飞书验收。保留所有测试结果的摘要和时间，不把真实正文、访问令牌或模型输入全文保存进 Git。

### Task 3: 最终切换决策

**Files:**
- Modify: `docs/implementation/acceptance-log.md`
- Modify: `docs/implementation/decision-log.md`
- Create: `docs/operations/rollback.md`（位于 `KnowledgeBase-Yuxi`）

- [ ] **Step 1: 生成切换清单**

清单必须逐项列出：统一 FastAPI 地址、React 构建版本、数据库备份、MinIO 证据抽查、正式索引数量、飞书根节点、OAuth 回调地址、旧 Fastify 当前端口、回退命令和批准人。

- [ ] **Step 2: 验证回退路径**

在不删除新数据的前提下，停止新 React/FastAPI 入口，按 `rollback.md` 恢复旧 React + Fastify 原型；验证 `/api/session` 和旧问答演示可打开，再重新切回新系统。

Expected: 两次切换均成功；任何一步失败则最终状态为 NO-GO。

- [ ] **Step 3: 获取明确切换确认**

向用户展示最终 PASS/FAIL 表和仍存在的风险。只有用户明确回复同意切换，才执行旧 Fastify 停用；“测试通过”不等同于授权删除旧代码或数据。

- [ ] **Step 4: 停用而不删除旧后端**

移除生产/本机正式启动脚本中的 Fastify 进程，保留源码、Git 历史和备份。验证浏览器网络请求只指向统一 FastAPI。

- [ ] **Step 5: 提交切换记录**

```bash
git add docs/implementation docs/operations/rollback.md
git commit -m "docs: record knowledge platform cutover"
```

Expected: 提交只包含脱敏验收摘要、决策和回退说明。

## 4. 最终完成定义

以下十二项必须同时为 PASS：

- [ ] Yuxi `v0.7.1` 在隔离目录和独立 Docker 资源中运行。
- [ ] React 只访问统一 FastAPI，旧 Fastify 不承担正式业务。
- [ ] PostgreSQL 是唯一业务主库，Redis/Milvus 可重建。
- [ ] 指定飞书 Wiki 根节点可以递归、分页、增量、幂等同步。
- [ ] 飞书 ACL、组织成员关系和多来源交集参与检索前过滤。
- [ ] 撤权、移出、删除或 ACL 不确定会立即阻断召回与引用。
- [ ] 原始 Section/Candidate 不进入员工问答，AI 不能发布知识。
- [ ] 正式知识版本、审核意见和证据链不可变且可追溯。
- [ ] Q900 4 张到 6 张的更新闭环端到端通过。
- [ ] 客户需求资料与正式知识联合推理、双来源引用和 24h 过期通过。
- [ ] Worker 重启、Redis 清空、Milvus 重建和索引失败回退通过。
- [ ] 自动测试、真实飞书只读测试、桌面/移动浏览器测试和回退演练通过。

任一项未通过，系统仍处于迁移中，不宣布完成，也不删除旧工程。

## 5. 规格覆盖自查

| 已批准规格章节 | 对应实施计划与任务 | 覆盖结论 |
| --- | --- | --- |
| 目标、原则、选型、工程边界、阶段外范围 | 本路线图第 0–2 节；阶段 1 Task 1–5 | 已覆盖 |
| 用户、四角色、飞书登录、本地应急管理员 | 阶段 2 Task 2/6；阶段 3 Task 1/3；阶段 5 Task 7 | 已覆盖 |
| PostgreSQL/MinIO/Milvus/Redis 数据所有权 | 阶段 1 Task 2–4；阶段 2 Task 1/3–5；阶段 4 Task 5/6；阶段 6 Task 4/5 | 已覆盖 |
| Asset、Revision、Section、Candidate、Review、Knowledge、Job/Outbox | 阶段 2 Task 2–6；阶段 3 Task 1/4/5；阶段 4 Task 1–6 | 已覆盖 |
| Conversation、SessionAsset、主动提交治理 | 阶段 5 Task 1/2/5/7–9 | 已覆盖 |
| 飞书根目录、递归/分页/增量/对账/变更矩阵 | 阶段 3 Task 2/4/5/7/8 | 已覆盖 |
| 飞书 ACL、组织成员、多来源交集、撤权和引用复核 | 阶段 3 Task 1/3/6/8；阶段 5 Task 3/5；阶段 6 Task 3 | 已覆盖 |
| 候选提取、正式知识比较、人工审核、发布一致性 | 阶段 4 Task 1–7 | 已覆盖 |
| 正式/临时 RAG 隔离、模型切换和索引重建 | 阶段 4 Task 3/5/6；阶段 5 Task 2/3；阶段 6 Task 5 | 已覆盖 |
| 企业问答、联合推理、三范围、双来源引用、24h 生命周期 | 阶段 5 Task 2–5/8/10 | 已覆盖 |
| 反馈修复闭环 | 阶段 5 Task 6/9/10 | 已覆盖 |
| 外部模型、普通解析、RapidOCR、秘密保护 | 阶段 1 Task 3/5；阶段 3 Task 5；阶段 4 Task 1/2；阶段 6 Task 2/3 | 已覆盖 |
| 可靠任务、故障矩阵、备份与恢复 | 阶段 2 Task 4/5/7；阶段 6 Task 4–6 | 已覆盖 |
| API 边界与 React 中文浅蓝界面 | 阶段 2 Task 6；阶段 3 Task 3/7；阶段 4 Task 4/6；阶段 5 Task 5/7–9 | 已覆盖 |
| Q900、客户需求、真实飞书、桌面/移动最终验收 | 阶段 4 Task 7；阶段 5 Task 4/10；阶段 6 Task 7–9 | 已覆盖 |

自查结论：规格 1–24 节及最终 12 条验收均有明确任务和门禁；没有把音视频 ASR、Neo4j、多租户、本地模型、自动发布、自动文档排版、Kubernetes 或高可用带入第一阶段。
