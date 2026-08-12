# 候选加工、审核与正式发布 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把飞书证据 Section 加工为可审核的原子 Candidate，经人工决策生成不可变 KnowledgeVersion，并在正式索引成功后原子切换为可问答知识。

**Architecture:** 外部对话模型只通过版本化 Pydantic Schema 产生候选与比较建议，三次结构失败后转人工异常。确定性规则与正式知识混合召回共同生成 Review；审核事务创建不可变版本和索引 Outbox，专用 formal indexer 将可重建表示写入 Milvus，成功后在 PostgreSQL 切换 active version，失败时保留旧有效版本。

**Tech Stack:** FastAPI、Pydantic v2、SQLAlchemy、PostgreSQL、ARQ、Yuxi model provider、OpenAI-compatible structured output、Milvus hybrid search/BM25、pytest、pytest-httpx。

---

## 文件结构

```text
KnowledgeBase-Yuxi/backend/
├── alembic/versions/20260812_0003_processing_publish.py
├── package/yuxi/governance/
│   ├── extraction_schemas.py      # 模型结构输出
│   ├── prompt_registry.py         # 版本化系统提示
│   ├── extraction_service.py      # Section -> Candidate
│   ├── comparison_service.py      # Candidate -> 关系/目标/差异
│   ├── deterministic_checks.py    # 数值、版本、否定、条件检查
│   ├── review_service.py          # 人工决策
│   ├── publication_service.py     # 发布事务和原子切换
│   ├── formal_indexer.py          # formal_knowledge 写入/删除/重建
│   └── jobs.py
├── server/routers/
│   ├── governance_candidate_router.py
│   ├── governance_review_router.py
│   └── governance_knowledge_router.py
└── test/
    ├── fixtures/governance/q900_v1.json
    ├── fixtures/governance/q900_v2.json
    ├── unit/governance/
    │   ├── test_extraction_schema.py
    │   ├── test_extraction_service.py
    │   ├── test_deterministic_checks.py
    │   ├── test_comparison_service.py
    │   ├── test_review_service.py
    │   ├── test_publication_service.py
    │   └── test_formal_indexer.py
    ├── integration/governance/
    │   ├── test_review_publication_transaction.py
    │   ├── test_index_atomic_switch.py
    │   └── test_formal_index_rebuild.py
    └── e2e/governance/test_q900_update.py
```

Milvus collection 固定命名 `formal_knowledge_v{index_version}`；不创建 Section collection。每个 entity 的 `knowledge_version_id`、`access_policy_id`、`representation_kind`、`index_version` 是必填标量字段。

### Task 1: 固化模型输出 Schema 与提示版本

**Files:**
- Create: `backend/package/yuxi/governance/extraction_schemas.py`
- Create: `backend/package/yuxi/governance/prompt_registry.py`
- Test: `backend/test/unit/governance/test_extraction_schema.py`

- [ ] **Step 1: 写失败 Schema 测试**

Create `backend/test/unit/governance/test_extraction_schema.py`:

```python
import pytest
from pydantic import ValidationError

from yuxi.governance.extraction_schemas import CandidateDraft, ComparisonDraft
from yuxi.governance.prompt_registry import EXTRACTION_PROMPT_VERSION, get_prompt


def test_candidate_requires_atomic_fact_and_direct_evidence():
    candidate = CandidateDraft.model_validate({
        "title": "Q900 标准部署最低 GPU",
        "knowledge_type": "PRODUCT_REQUIREMENT",
        "subject": "Q900 3.2",
        "conditions": "标准部署模式",
        "conclusion": "最低需要 4 张 A800",
        "effective_constraints": "适用于 3.2 版本",
        "source_quote": "Q900 3.2 标准部署最低配置为 4 张 A800。",
        "source_locator": "block:b-17",
        "confidence": 0.94,
    })
    assert candidate.normalized_content == "Q900 3.2｜标准部署模式｜最低需要 4 张 A800｜适用于 3.2 版本"


def test_candidate_rejects_empty_evidence_and_invalid_confidence():
    with pytest.raises(ValidationError):
        CandidateDraft.model_validate({
            "title": "GPU", "knowledge_type": "PRODUCT_REQUIREMENT", "subject": "Q900",
            "conditions": "", "conclusion": "4", "effective_constraints": "",
            "source_quote": "", "source_locator": "", "confidence": 1.2,
        })


def test_comparison_relation_is_closed_enum():
    with pytest.raises(ValidationError):
        ComparisonDraft.model_validate({"relation": "MAYBE", "confidence": 0.5, "reason": "不确定"})


def test_prompt_version_is_explicit():
    assert EXTRACTION_PROMPT_VERSION == "candidate-extraction-v1"
    assert "不得发布" in get_prompt(EXTRACTION_PROMPT_VERSION)
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && uv run pytest test/unit/governance/test_extraction_schema.py -v`

Expected: FAIL，Schema 和 prompt registry 不存在。

- [ ] **Step 3: 实现严格 Pydantic Schema**

Create `extraction_schemas.py`:

```python
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, computed_field

from yuxi.governance.domain import CandidateRelation


class CandidateDraft(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    title: str = Field(min_length=4, max_length=200)
    knowledge_type: str = Field(min_length=2, max_length=64)
    subject: str = Field(min_length=1, max_length=300)
    conditions: str = Field(min_length=1, max_length=1000)
    conclusion: str = Field(min_length=2, max_length=2000)
    effective_constraints: str = Field(min_length=1, max_length=1000)
    source_quote: str = Field(min_length=2, max_length=4000)
    source_locator: str = Field(min_length=2, max_length=500)
    confidence: float = Field(ge=0, le=1)

    @computed_field
    @property
    def normalized_content(self) -> str:
        return "｜".join((self.subject, self.conditions, self.conclusion, self.effective_constraints))


class ExtractionResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    candidates: list[CandidateDraft] = Field(max_length=30)


class ComparisonDraft(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    relation: CandidateRelation
    target_knowledge_id: str | None = None
    confidence: float = Field(ge=0, le=1)
    reason: str = Field(min_length=4, max_length=2000)
    risk: Literal["LOW", "MEDIUM", "HIGH"]
```

- [ ] **Step 4: 写版本化提示注册表**

`prompt_registry.py` 只包含已审核的常量；`candidate-extraction-v1` 明确写入：只依据给定 Section、输出主体/条件/结论/生效约束、逐字证据、不得整章、不得使用常识、不得判断发布。`candidate-comparison-v1` 明确只在传入正式知识范围内选择五种关系，不得把相似性当事实。

暴露：

```python
EXTRACTION_PROMPT_VERSION = "candidate-extraction-v1"
COMPARISON_PROMPT_VERSION = "candidate-comparison-v1"


def get_prompt(version: str) -> str:
    try:
        return PROMPTS[version]
    except KeyError as exc:
        raise ValueError(f"未知提示版本: {version}") from exc
```

- [ ] **Step 5: 运行 Schema 测试**

Run: `cd backend && uv run pytest test/unit/governance/test_extraction_schema.py -v`

Expected: 4 tests PASS。

- [ ] **Step 6: 提交 Schema 和提示**

```bash
git add backend/package/yuxi/governance/extraction_schemas.py backend/package/yuxi/governance/prompt_registry.py \
  backend/test/unit/governance/test_extraction_schema.py
git commit -m "feat: version candidate model contracts"
```

### Task 2: 实现候选提取、证据校验和三次失败

**Files:**
- Create: `backend/alembic/versions/20260812_0003_processing_publish.py`
- Modify: `backend/package/yuxi/governance/models.py`
- Create: `backend/package/yuxi/governance/extraction_service.py`
- Test: `backend/test/unit/governance/test_extraction_service.py`

- [ ] **Step 1: 写提取失败测试**

测试断言：有效输出生成 Candidate；source_quote 必须是 Section 正文子串；locator 必须对应当前 Section；同 revision/section/hash 幂等；三次无效 JSON 后创建 `ProcessingException(code=MODEL_SCHEMA_INVALID)`；模型暂时不可用不丢 Section 并让 Job 重试；模型输出 Authority 被忽略，Candidate authority 只继承 Asset。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && uv run pytest test/unit/governance/test_extraction_service.py -v`

Expected: FAIL，提取服务不存在。

- [ ] **Step 3: 增加工异常记录迁移**

`20260812_0003` 创建：

```text
governance_processing_exceptions:
  id, revision_id(FK), section_id(FK nullable), stage, code, message,
  model_version, prompt_version, attempts, status(OPEN|RESOLVED),
  created_at, resolved_at
```

并为 Candidate 增加 `comparison_model_version`、`comparison_prompt_version`。异常 `message` 只保存解析错误摘要，最长 2000 字符，不保存模型完整原始响应。

- [ ] **Step 4: 实现 ExtractionService**

核心接口：

```python
class ExtractionService:
    def __init__(self, repository, model_gateway, clock):
        self.repository = repository
        self.model_gateway = model_gateway
        self.clock = clock

    async def extract_revision(self, revision_id: str, *, model_spec: str) -> list[Candidate]:
        revision = await self.repository.require_revision(revision_id)
        candidates = []
        for section in await self.repository.list_sections(revision_id):
            candidates.extend(await self.extract_section(section, model_spec=model_spec))
        await self.repository.mark_revision_stage(revision.id, RevisionStage.COMPARING)
        return candidates

    async def extract_section(self, section: Section, *, model_spec: str) -> list[Candidate]:
        result = await self.model_gateway.structured(
            model_spec=model_spec,
            system_prompt=get_prompt(EXTRACTION_PROMPT_VERSION),
            input_text=section.content,
            response_model=ExtractionResult,
            max_attempts=3,
        )
        drafts = [validate_evidence(draft, section) for draft in result.candidates]
        return await self.repository.insert_candidate_drafts(section, drafts)
```

每个 Section 最多三次模型调用；每次将 Pydantic 的 `ExtractionResult.model_json_schema()` 作为 structured response schema。解析后执行：`source_quote in section.content`、locator 与 Section 一致、内容不是整节（quote 长度不得超过 Section 的 80%，但少于 500 字不受此限制）、conclusion 不能只是数字/词语。候选 hash：

```python
sha256(f"{revision.id}\0{section.id}\0{draft.normalized_content}".encode()).hexdigest()
```

使用唯一约束 `ON CONFLICT DO NOTHING` 实现幂等。Revision 所有 Section 完成后才从 EXTRACTING 进入 COMPARING。

- [ ] **Step 5: 运行提取测试**

Run:

```bash
cd backend
uv run alembic upgrade head
uv run pytest test/unit/governance/test_extraction_service.py -v
```

Expected: 全部 PASS。

- [ ] **Step 6: 提交候选提取**

```bash
git add backend/alembic/versions/20260812_0003_processing_publish.py backend/package/yuxi/governance/models.py \
  backend/package/yuxi/governance/extraction_service.py backend/test/unit/governance/test_extraction_service.py
git commit -m "feat: extract evidence-bound candidates"
```

### Task 3: 实现正式知识比较与确定性校验

**Files:**
- Create: `backend/package/yuxi/governance/deterministic_checks.py`
- Create: `backend/package/yuxi/governance/comparison_service.py`
- Test: `backend/test/unit/governance/test_deterministic_checks.py`
- Test: `backend/test/unit/governance/test_comparison_service.py`

- [ ] **Step 1: 写数值、版本、否定和条件测试**

Create representative assertions:

```python
def test_numeric_change_is_update_not_duplicate():
    result = inspect_difference("最低需要 4 张 A800", "最低需要 6 张 A800")
    assert result.numeric_changes == [("4", "6")]
    assert result.duplicate_allowed is False


def test_negation_change_is_high_risk_conflict():
    result = inspect_difference("支持 Oracle 19c", "不支持 Oracle 19c")
    assert result.negation_changed is True
    assert result.force_relation == "CONFLICT"


def test_different_version_does_not_force_conflict():
    result = inspect_difference("Q900 3.1 最低 4 张", "Q900 3.2 最低 6 张")
    assert result.version_changed is True
    assert result.force_relation is None
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && uv run pytest test/unit/governance/test_deterministic_checks.py test/unit/governance/test_comparison_service.py -v`

Expected: FAIL，比较模块不存在。

- [ ] **Step 3: 实现确定性检查**

`inspect_difference(current,proposed)` 返回 `numeric_changes,version_changed,negation_changed,condition_changed,duplicate_allowed,force_relation,reasons`。中文/英文否定词固定集合：`不,不得,禁止,不支持,无需,不能,no,not,never,unsupported`；版本正则识别 `v3.2/3.2 版本/Q900-3.2`；数值保留单位邻域。规则只否决不安全的 DUPLICATE 或升级 CONFLICT，不自行发布知识。

- [ ] **Step 4: 实现 ComparisonService**

顺序严格为：

1. 以 `subject + knowledge_type + version + conditions` 在 `formal_knowledge` 过滤当前 ACTIVE/INDEXED 项。
2. 使用 Milvus vector + BM25 hybrid，返回最多 10 个 `KnowledgeVersion` ID。
3. 从 PostgreSQL 读取正式版本正文和适用条件；不把 Candidate/Section 放入检索候选。
4. 无召回则 NEW；有召回则调用结构化比较模型。
5. 运行确定性检查修正不安全结果。
6. DUPLICATE 仅当 confidence >= 0.90 且规则允许时 AUTO_CLOSED；其余都创建 Review。CONFLICT risk=HIGH；INSUFFICIENT 进入待补充。

接口：

```python
async def compare_candidate(candidate_id: str, *, model_spec: str) -> ComparisonResult
async def compare_revision(revision_id: str, *, model_spec: str) -> list[ComparisonResult]
```

- [ ] **Step 5: 补齐关系矩阵测试**

覆盖 NEW/DUPLICATE(0.91 自动关闭)/DUPLICATE(0.89 人工)/UPDATE/CONFLICT/INSUFFICIENT、数值变化阻止 duplicate、无效模型结构转人工异常、召回只包含 ACTIVE/INDEXED。

- [ ] **Step 6: 运行比较测试**

Run:

```bash
cd backend
uv run pytest test/unit/governance/test_deterministic_checks.py test/unit/governance/test_comparison_service.py -v
```

Expected: 全部 PASS。

- [ ] **Step 7: 提交比较服务**

```bash
git add backend/package/yuxi/governance/deterministic_checks.py backend/package/yuxi/governance/comparison_service.py \
  backend/test/unit/governance/test_deterministic_checks.py backend/test/unit/governance/test_comparison_service.py
git commit -m "feat: compare candidates with formal knowledge"
```

### Task 4: 实现不可变人工审核用例与 API

**Files:**
- Create: `backend/package/yuxi/governance/review_service.py`
- Create: `backend/server/routers/governance_candidate_router.py`
- Create: `backend/server/routers/governance_review_router.py`
- Modify: `backend/server/routers/__init__.py`
- Test: `backend/test/unit/governance/test_review_service.py`
- Test: `backend/test/unit/governance/test_review_router.py`

- [ ] **Step 1: 写审核动作矩阵失败测试**

覆盖：CREATE/UPDATE/CONFLICT/ARCHIVE/SOURCE_CHANGE；完成必须有意见；只能负责人/ADMIN；转交人必须对所有来源有当前访问权；完成 Review 不可再编辑；纠错创建新 Review；AI actor 被拒；final_content 可人工修改但不能为空；Authority 不能由 AI 提高。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && uv run pytest test/unit/governance/test_review_service.py test/unit/governance/test_review_router.py -v`

Expected: FAIL，审核服务/路由不存在。

- [ ] **Step 3: 实现 ReviewService 状态命令**

```python
async def assign(review_id: str, assignee_uid: str, actor: Actor) -> Review
async def complete(review_id: str, command: ReviewDecision, actor: Actor) -> Review
async def create_correction(review_id: str, reason: str, actor: Actor) -> Review
```

`ReviewDecision`：

```python
class ReviewDecision(BaseModel):
    action: Literal[
        "CREATE_KNOWLEDGE", "UPDATE_KNOWLEDGE", "KEEP_CURRENT", "MARK_DUPLICATE",
        "REJECT", "MARK_INSUFFICIENT", "ARCHIVE_KNOWLEDGE"
    ]
    final_content: str | None = Field(default=None, max_length=10000)
    decision_comment: str = Field(min_length=2, max_length=2000)
```

CREATE/UPDATE 要求 final_content；ARCHIVE 要求 target knowledge；完成时将 Candidate 状态同步为 ACCEPTED/REJECTED/INSUFFICIENT/AUTO_CLOSED，并在同一事务调用 publication service 创建待发布版本或归档事务。

- [ ] **Step 4: 实现列表/详情/转交/完成 API**

```text
GET  /api/governance/candidates
GET  /api/governance/candidates/{candidate_id}
GET  /api/governance/reviews
GET  /api/governance/reviews/{review_id}
POST /api/governance/reviews/{review_id}/assign
POST /api/governance/reviews/{review_id}/complete
POST /api/governance/reviews/{review_id}/corrections
```

详情响应必须同时包含 Candidate、source_excerpt/locator/source_url、当前 KnowledgeVersion/diff、AI relation/reason/confidence、Authority、历史 Review；无当前 ACL 的审核人只能转交，不能看到正文或完成决策。

- [ ] **Step 5: 运行审核测试**

Run: `cd backend && uv run pytest test/unit/governance/test_review_service.py test/unit/governance/test_review_router.py -v`

Expected: 全部 PASS。

- [ ] **Step 6: 提交审核用例**

```bash
git add backend/package/yuxi/governance/review_service.py backend/server/routers/governance_candidate_router.py \
  backend/server/routers/governance_review_router.py backend/server/routers/__init__.py \
  backend/test/unit/governance/test_review_service.py backend/test/unit/governance/test_review_router.py
git commit -m "feat: require immutable human knowledge reviews"
```

### Task 5: 实现正式索引表示与权限过滤

**Files:**
- Create: `backend/package/yuxi/governance/formal_indexer.py`
- Test: `backend/test/unit/governance/test_formal_indexer.py`
- Test: `backend/test/integration/governance/test_formal_index_rebuild.py`

- [ ] **Step 1: 写正式索引边界失败测试**

断言一个 KnowledgeVersion 产生 `TITLE,ATOMIC_STATEMENT,SYNONYM_QUESTION,APPLICABILITY` 四类表示；每条包含相同 version/policy；Section/Candidate 写入会抛 `FormalIndexBoundaryError`；不同 embedding model 不允许写同一 index_version；query 必须先给 allowed policy IDs；空 IDs 不调用 Milvus并返回空。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && uv run pytest test/unit/governance/test_formal_indexer.py -v`

Expected: FAIL，formal indexer 不存在。

- [ ] **Step 3: 实现 collection schema 和索引**

Milvus entity：

```python
class FormalEntity(TypedDict):
    entity_id: str
    knowledge_id: str
    knowledge_version_id: str
    access_policy_id: str
    representation_kind: str
    text: str
    embedding: list[float]
    index_version: int
```

collection 有上述 scalar 字段、dense vector 和 BM25 sparse 字段；filter 必须使用当前用户实际 `allowed_policy_ids` 构造 `access_policy_id in [policy_id_1, policy_id_2]`，并同时包含 `index_version == current_index_version`。`build_version` 只接受 `PublishedKnowledgeProjection`，类型中没有 Section/Candidate 构造入口。synonym question 由模型生成但保存 prompt/model version；生成失败时标题、原子陈述和适用条件仍可索引。

- [ ] **Step 4: 实现全量重建**

`rebuild(index_version,embedding_model)` 新建 `formal_knowledge_vN`，从 PostgreSQL 分页读取当前可用 KnowledgeVersion，构建并核对 entity 数；全部成功后更新 PostgreSQL `active_formal_index_version=N`。旧 collection 保留到验收通过后再由明确运维动作删除；不能在同一 collection 混用模型。

- [ ] **Step 5: 写删除 Milvus 后重建集成测试**

发布三个合成正式知识，drop 测试 collection，运行 rebuild；断言 PostgreSQL/MinIO 未改变、entity 数恢复、三条知识按 policy 可召回、无 Section 文本。

- [ ] **Step 6: 运行正式索引测试**

Run:

```bash
cd backend
uv run pytest test/unit/governance/test_formal_indexer.py -v
uv run pytest test/integration/governance/test_formal_index_rebuild.py -m integration -v
```

Expected: 全部 PASS。

- [ ] **Step 7: 提交正式索引**

```bash
git add backend/package/yuxi/governance/formal_indexer.py backend/test/unit/governance/test_formal_indexer.py \
  backend/test/integration/governance/test_formal_index_rebuild.py
git commit -m "feat: index only published formal knowledge"
```

### Task 6: 实现发布事务、失败重试和原子切换

**Files:**
- Create: `backend/package/yuxi/governance/publication_service.py`
- Modify: `backend/package/yuxi/governance/jobs.py`
- Create: `backend/server/routers/governance_knowledge_router.py`
- Modify: `backend/server/routers/__init__.py`
- Test: `backend/test/unit/governance/test_publication_service.py`
- Test: `backend/test/integration/governance/test_review_publication_transaction.py`
- Test: `backend/test/integration/governance/test_index_atomic_switch.py`

- [ ] **Step 1: 写发布状态失败测试**

覆盖：人工 CREATE 创建 Knowledge/PUBLISHING version/PENDING VersionIndex/Outbox；事务失败全部回滚；index 成功才 ACTIVE/INDEXED；index 失败新版本 FAILED、旧 ACTIVE 仍回答；首版失败无 ACTIVE；来源失效时旧版也不回答；重试不重复 version/entity；归档立即停止召回。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && uv run pytest test/unit/governance/test_publication_service.py -v`

Expected: FAIL，publication service 不存在。

- [ ] **Step 3: 实现审核通过事务**

```python
async def stage_publication(session, review, decision) -> Publication:
    assert review.status == ReviewStatus.OPEN
    assert decision.decision_comment.strip()
    candidate = await require_candidate(session, review.candidate_id)
    await assert_candidate_accepted(decision.action, candidate)
    knowledge = await get_or_create_knowledge(
        session=session,
        target_knowledge_id=review.target_knowledge_id,
        title=candidate.title,
        owner_uid=review.owner_uid,
        category=candidate.knowledge_type,
    )
    policy = await build_current_access_policy(session, candidate.id)
    version = KnowledgeVersion(
        version_no=knowledge.next_version_no(), content=decision.final_content,
        review_id=review.id, reviewer_uid=review.reviewer_uid,
        decision_comment=decision.decision_comment,
    )
    access = VersionAccessProjection(
        knowledge_version_id=version.id, access_policy_id=policy.id,
        projection_version=policy.projection_version, status="VALID",
    )
    index = VersionIndex(
        knowledge_version_id=version.id, index_version=current_index_version,
        index_model=current_embedding_model, status=IndexStatus.PENDING,
        collection_name=f"formal_knowledge_v{current_index_version}",
    )
    knowledge.status = KnowledgeStatus.ACTIVE if knowledge.active_version_id else KnowledgeStatus.PUBLISHING
    knowledge.pending_version_id = version.id
    await write_outbox("INDEX_KNOWLEDGE_VERSION", version.id, priority=50)
    return Publication(knowledge=knowledge, version=version, access=access, index=index)
```

版本 sources 从 Candidate 证据和审核人选择的辅助证据创建；AccessPolicy 使用逐来源授权子句表达当前 ACL 交集，当前策略通过可变 `VersionAccessProjection` 关联，不写入不可变版本行。完成 Review、Candidate 状态、版本、access projection、index row 和 Outbox 同一事务提交。

- [ ] **Step 4: 实现索引完成的原子切换**

Worker 构建 Milvus entities 后在新事务 `SELECT Knowledge FOR UPDATE`：若 pending_version 仍为该版本且来源仍 ACTIVE、VersionAccessProjection VALID，则把 VersionIndex 标 INDEXED、`knowledge.active_version_id=version.id`、`pending_version_id=NULL`、`status=ACTIVE`；旧版本保留不可变历史。失败则 VersionIndex FAILED，Knowledge 有旧 active 时保持 ACTIVE、无旧 active 时保持 PUBLISHING，Job 按最多五次重试。

来源删除/移出/明确撤权事务先使 policy 和 VersionAccessProjection INVALID，让相关 active version 立即无法召回；若该 Knowledge 没有仍具有效证据的其他 active version，再把 Knowledge 标 STALE。该阻断不等待 Milvus 删除完成。

- [ ] **Step 5: 实现知识 API**

```text
GET  /api/governance/knowledge
GET  /api/governance/knowledge/{knowledge_id}
GET  /api/governance/knowledge/{knowledge_id}/versions
POST /api/governance/knowledge/{knowledge_id}/reindex
POST /api/governance/knowledge/rebuild-index
```

详情组合不可变 version 与最新 VersionIndex，返回规格字段 `index_status,index_model,index_version`；重建只允许 ADMIN 且请求需 `confirmation="REBUILD_FORMAL_INDEX"`。

- [ ] **Step 6: 运行发布集成测试**

Run:

```bash
cd backend
uv run pytest test/unit/governance/test_publication_service.py -v
uv run pytest test/integration/governance/test_review_publication_transaction.py \
  test/integration/governance/test_index_atomic_switch.py -m integration -v
```

Expected: 全部 PASS。

- [ ] **Step 7: 提交发布链路**

```bash
git add backend/package/yuxi/governance/publication_service.py backend/package/yuxi/governance/jobs.py \
  backend/server/routers/governance_knowledge_router.py backend/server/routers/__init__.py \
  backend/test/unit/governance/test_publication_service.py backend/test/integration/governance/test_review_publication_transaction.py \
  backend/test/integration/governance/test_index_atomic_switch.py
git commit -m "feat: publish knowledge after successful indexing"
```

### Task 7: Q900 4 张到 6 张端到端门禁

**Files:**
- Create: `backend/test/fixtures/governance/q900_v1.json`
- Create: `backend/test/fixtures/governance/q900_v2.json`
- Create: `backend/test/e2e/governance/test_q900_update.py`
- Modify: `docs/implementation/acceptance-log.md`

- [ ] **Step 1: 创建合成证据 fixture**

`q900_v1.json` 包含唯一飞书节点、Revision 正文“Q900 3.2 在标准部署模式下，最低需要 4 张 A800。”、定位 `block:q900-gpu` 和允许测试用户 ACL。`q900_v2.json` 保持同节点/定位，将正文改为“最低需要 6 张 A800”，修改时间和 content hash 增加。fixture 不引用真实企业资料。

- [ ] **Step 2: 写完整失败 E2E**

Test sequence:

```text
ingest V1 -> extract -> relation NEW -> human CREATE -> index -> ACTIVE V1
query formal index -> returns 4 + V1
ingest V2 -> extract -> deterministic numeric change -> relation UPDATE -> open review
before review query -> still returns 4 + V1
human UPDATE -> index -> ACTIVE V2
query -> returns 6 + V2; V1 remains readable as history
```

同时断言模型 actor 直接调用 complete 返回 403；Section 文本不能从员工检索接口返回。

- [ ] **Step 3: 运行 E2E 确认失败并补齐编排**

Run: `cd backend && uv run pytest test/e2e/governance/test_q900_update.py -m e2e -v`

Expected before final wiring: FAIL at first missing handler/API. Register `EXTRACT_REVISION`、`COMPARE_REVISION`、`INDEX_KNOWLEDGE_VERSION` handlers and route dependencies until the same test passes;不改变 fixture 期望来迎合实现。

- [ ] **Step 4: 运行全阶段测试和 lint**

Run:

```bash
cd backend
uv run pytest test/unit/governance -v
uv run pytest test/integration/governance -m integration -v
uv run pytest test/e2e/governance/test_q900_update.py -m e2e -v
uv run ruff check package/yuxi/governance server/routers/governance_*.py
```

Expected: 全部退出码 0。

- [ ] **Step 5: 记录并签署阶段门禁**

`acceptance-log.md` 记录 Candidate 原子性、五种关系、人工发布、索引失败、旧版回退、正式索引重建和 Q900 V1/V2 全部 PASS。

- [ ] **Step 6: 提交 E2E 和验收记录**

```bash
git add backend/test/fixtures/governance backend/test/e2e/governance/test_q900_update.py \
  docs/implementation/acceptance-log.md
git commit -m "test: accept governed q900 knowledge updates"
```

Expected: 阶段 4 为 PASS；只有该提交存在后才让 React 员工问答访问正式知识。
