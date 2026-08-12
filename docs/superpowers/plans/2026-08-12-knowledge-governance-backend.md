# PostgreSQL 知识治理后端 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Yuxi FastAPI 内建立以 PostgreSQL 为唯一业务事实的治理领域、显式数据库迁移、事务 Job/Outbox 和可重启后台任务骨架。

**Architecture:** 治理模型使用独立 SQLAlchemy `GovernanceBase` 并放入 `yuxi.governance` 包，由 Alembic 单独管理，避免把上游 Yuxi 的启动时 `create_all` 纳入定制迁移。应用服务只通过 Repository 操作数据；业务事务同步写入 Outbox，独立 dispatcher 投递 ARQ，Worker 每次执行前后都持久化 Job 状态，Redis 丢失时由 PostgreSQL 恢复。

**Tech Stack:** Python 3.13、FastAPI、Pydantic v2、SQLAlchemy asyncio、Alembic、PostgreSQL 16、ARQ、Redis、pytest、pytest-asyncio、Docker Compose。

---

## 文件结构

```text
KnowledgeBase-Yuxi/backend/
├── alembic.ini
├── alembic/
│   ├── env.py
│   ├── script.py.mako
│   └── versions/20260812_0001_governance_core.py
├── package/yuxi/governance/
│   ├── __init__.py
│   ├── domain.py                 # 稳定枚举、值对象和领域规则
│   ├── models.py                 # SQLAlchemy 治理模型
│   ├── schemas.py                # API 输入输出 Schema
│   ├── repository.py             # 治理对象持久化
│   ├── job_repository.py         # Job/Outbox 原子操作
│   ├── job_service.py            # 创建、重试、取消、恢复
│   ├── dispatcher.py             # Outbox -> ARQ
│   ├── worker.py                 # 治理任务执行入口
│   └── service.py                # 资料/候选/审核/知识查询用例
├── server/routers/
│   ├── governance_router.py
│   └── __init__.py
└── test/
    ├── unit/governance/
    │   ├── test_domain.py
    │   ├── test_job_service.py
    │   ├── test_dispatcher.py
    │   └── test_governance_router.py
    └── integration/governance/
        ├── test_migrations.py
        ├── test_immutability.py
        └── test_job_recovery.py
```

模型字段使用 `snake_case`；API JSON 也使用 `snake_case`，React 阶段统一按这一契约生成 TypeScript 类型，不增加第二套命名转换。

### Task 1: 引入显式 Alembic 迁移门禁

**Files:**
- Modify: `backend/package/pyproject.toml`
- Modify: `backend/pyproject.toml`
- Modify: `docker/api.Dockerfile`
- Modify: `compose.phase1.yml`
- Create: `backend/alembic.ini`
- Create: `backend/alembic/env.py`
- Create: `backend/alembic/script.py.mako`
- Create: `backend/package/yuxi/governance/__init__.py`
- Create: `backend/package/yuxi/governance/models.py`
- Test: `backend/test/unit/governance/test_migration_contract.py`

- [ ] **Step 1: 写迁移契约失败测试**

Create `backend/test/unit/governance/test_migration_contract.py`:

```python
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[3]
REPO = ROOT.parent


def test_alembic_uses_postgres_url_and_governance_metadata():
    env = (ROOT / "alembic" / "env.py").read_text()
    assert "POSTGRES_URL" in env
    assert "GovernanceBase.metadata" in env
    assert "import yuxi.governance.models" in env


def test_api_and_worker_wait_for_successful_migration():
    config = yaml.safe_load((REPO / "compose.phase1.yml").read_text())
    assert config["services"]["migrate"]["command"][-2:] == ["upgrade", "head"]
    for service in ("api", "worker"):
        assert config["services"][service]["depends_on"]["migrate"]["condition"] == "service_completed_successfully"
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && uv run pytest test/unit/governance/test_migration_contract.py -v`

Expected: FAIL，原因是 Alembic 文件和 `migrate` 服务不存在。

- [ ] **Step 3: 增加依赖并初始化配置**

在 `backend/package/pyproject.toml` 的 dependencies 和 `backend/pyproject.toml` 的 dependencies 中分别加入：

```toml
"alembic>=1.16,<2",
```

Run:

```bash
cd backend
uv lock
uv run alembic init alembic
```

将 `backend/alembic.ini` 的数据库 URL 保持为空占位：

```ini
[alembic]
script_location = %(here)s/alembic
prepend_sys_path = . package
sqlalchemy.url =
```

- [ ] **Step 4: 配置 async Alembic 环境**

Replace `backend/alembic/env.py` with:

```python
import asyncio
import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.ext.asyncio import async_engine_from_config

import yuxi.governance.models  # noqa: F401
from yuxi.governance.models import GovernanceBase

config = context.config
if config.config_file_name:
    fileConfig(config.config_file_name)
url = os.environ["POSTGRES_URL"].replace("postgresql+psycopg://", "postgresql+asyncpg://")
config.set_main_option("sqlalchemy.url", url)
target_metadata = GovernanceBase.metadata


def run_migrations_offline():
    context.configure(url=url, target_metadata=target_metadata, literal_binds=True, compare_type=True)
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection):
    context.configure(connection=connection, target_metadata=target_metadata, compare_type=True)
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations():
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section), prefix="sqlalchemy.", poolclass=pool.NullPool
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_async_migrations())
```

Create `backend/package/yuxi/governance/__init__.py` with a package docstring. Create the initial `backend/package/yuxi/governance/models.py`:

```python
from sqlalchemy.orm import DeclarativeBase


class GovernanceBase(DeclarativeBase):
    """定制治理表的独立 Alembic metadata。"""
```

治理表以字符串 `owner_uid/reviewer_uid` 引用 Yuxi 用户，不建立跨 metadata 外键；Repository 写入前必须校验用户存在。这样空数据库可以先执行治理迁移，再由 Yuxi 原有启动逻辑创建上游业务表。

- [ ] **Step 5: 将迁移做成一次性 Compose 服务**

Modify `docker/api.Dockerfile` after copying server code:

```dockerfile
COPY backend/alembic.ini /app/alembic.ini
COPY backend/alembic /app/alembic
```

Add to `compose.phase1.yml` services:

```yaml
  migrate:
    build: {context: ., dockerfile: docker/api.Dockerfile}
    image: yuxi-api:${YUXI_VERSION:-0.7.1}
    working_dir: /app
    env_file: [.env]
    environment:
      POSTGRES_URL: postgresql+asyncpg://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-yuxi}
    command: ["uv", "run", "--no-sync", "--no-dev", "alembic", "-c", "alembic.ini", "upgrade", "head"]
    depends_on:
      postgres: {condition: service_healthy}
    networks: [app-network]
```

Override `api` and `worker` dependencies:

```yaml
    depends_on:
      migrate: {condition: service_completed_successfully}
      postgres: {condition: service_healthy}
      redis: {condition: service_healthy}
      minio: {condition: service_healthy}
      sandbox-provisioner: {condition: service_healthy}
```

- [ ] **Step 6: 运行契约测试和配置验证**

Run:

```bash
cd backend && uv run pytest test/unit/governance/test_migration_contract.py -v
cd .. && docker compose -f compose.phase1.yml --env-file .env config --quiet
```

Expected: 测试 PASS；Compose 配置退出码 0。

- [ ] **Step 7: 提交迁移框架**

```bash
git add backend/package/pyproject.toml backend/pyproject.toml backend/uv.lock backend/alembic.ini backend/alembic \
  backend/package/yuxi/governance/__init__.py backend/package/yuxi/governance/models.py \
  docker/api.Dockerfile compose.phase1.yml backend/test/unit/governance/test_migration_contract.py
git commit -m "chore: add explicit governance migrations"
```

### Task 2: 定义稳定领域枚举与状态规则

**Files:**
- Modify: `backend/package/yuxi/governance/__init__.py`
- Create: `backend/package/yuxi/governance/domain.py`
- Test: `backend/test/unit/governance/test_domain.py`

- [ ] **Step 1: 写失败领域测试**

Create `backend/test/unit/governance/test_domain.py`:

```python
import pytest

from yuxi.governance.domain import (
    Authority, CandidateRelation, KnowledgeStatus, RevisionStage,
    can_publish, next_revision_stage, require_human_decision,
)


def test_revision_stages_only_move_forward_or_fail():
    assert next_revision_stage(RevisionStage.DISCOVERED) is RevisionStage.FETCHING
    assert next_revision_stage(RevisionStage.COMPARING) is RevisionStage.READY
    with pytest.raises(ValueError, match="READY 没有下一处理阶段"):
        next_revision_stage(RevisionStage.READY)


def test_ai_cannot_publish_and_review_comment_is_required():
    assert not can_publish(actor_kind="AI", decision_comment="证据充分")
    assert not can_publish(actor_kind="HUMAN", decision_comment="  ")
    assert can_publish(actor_kind="HUMAN", decision_comment="已核对原文和适用版本")


def test_authority_cannot_be_raised_by_ai():
    with pytest.raises(ValueError, match="AI 无权提高来源权威"):
        require_human_decision(Authority.L1, Authority.L2, actor_kind="AI")


def test_publishing_is_not_active():
    assert KnowledgeStatus.PUBLISHING is not KnowledgeStatus.ACTIVE
    assert CandidateRelation.CONFLICT.value == "CONFLICT"
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && uv run pytest test/unit/governance/test_domain.py -v`

Expected: FAIL with `ModuleNotFoundError: yuxi.governance`。

- [ ] **Step 3: 写最小领域实现**

Create `backend/package/yuxi/governance/domain.py`:

```python
from enum import StrEnum


class Role(StrEnum):
    EMPLOYEE = "EMPLOYEE"
    KNOWLEDGE_OWNER = "KNOWLEDGE_OWNER"
    ADMIN = "ADMIN"
    LOCAL_SUPERADMIN = "LOCAL_SUPERADMIN"


class Authority(StrEnum):
    L0 = "L0"
    L1 = "L1"
    L2 = "L2"
    L3 = "L3"


class AssetLifecycle(StrEnum):
    ACTIVE = "ACTIVE"
    MOVED_OUT = "MOVED_OUT"
    DELETED = "DELETED"
    INACCESSIBLE = "INACCESSIBLE"
    UNSUPPORTED = "UNSUPPORTED"


class RevisionStage(StrEnum):
    DISCOVERED = "DISCOVERED"
    FETCHING = "FETCHING"
    PARSING = "PARSING"
    EXTRACTING = "EXTRACTING"
    COMPARING = "COMPARING"
    READY = "READY"
    FAILED = "FAILED"


class CandidateRelation(StrEnum):
    NEW = "NEW"
    DUPLICATE = "DUPLICATE"
    UPDATE = "UPDATE"
    CONFLICT = "CONFLICT"
    INSUFFICIENT = "INSUFFICIENT"


class CandidateStatus(StrEnum):
    PENDING_REVIEW = "PENDING_REVIEW"
    AUTO_CLOSED = "AUTO_CLOSED"
    ACCEPTED = "ACCEPTED"
    REJECTED = "REJECTED"
    INSUFFICIENT = "INSUFFICIENT"


class ReviewType(StrEnum):
    CREATE = "CREATE"
    UPDATE = "UPDATE"
    CONFLICT = "CONFLICT"
    ARCHIVE = "ARCHIVE"
    FEEDBACK = "FEEDBACK"
    SOURCE_CHANGE = "SOURCE_CHANGE"


class ReviewStatus(StrEnum):
    OPEN = "OPEN"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"


class AssetProvider(StrEnum):
    FEISHU_WIKI = "FEISHU_WIKI"


class KnowledgeStatus(StrEnum):
    DRAFT = "DRAFT"
    PUBLISHING = "PUBLISHING"
    ACTIVE = "ACTIVE"
    STALE = "STALE"
    ARCHIVED = "ARCHIVED"


class IndexStatus(StrEnum):
    PENDING = "PENDING"
    INDEXED = "INDEXED"
    FAILED = "FAILED"


class JobStatus(StrEnum):
    PENDING = "PENDING"
    DISPATCHED = "DISPATCHED"
    RUNNING = "RUNNING"
    RETRY_WAIT = "RETRY_WAIT"
    SUCCEEDED = "SUCCEEDED"
    NEEDS_ATTENTION = "NEEDS_ATTENTION"
    CANCELLED = "CANCELLED"


_REVISION_NEXT = {
    RevisionStage.DISCOVERED: RevisionStage.FETCHING,
    RevisionStage.FETCHING: RevisionStage.PARSING,
    RevisionStage.PARSING: RevisionStage.EXTRACTING,
    RevisionStage.EXTRACTING: RevisionStage.COMPARING,
    RevisionStage.COMPARING: RevisionStage.READY,
}


def next_revision_stage(current: RevisionStage) -> RevisionStage:
    try:
        return _REVISION_NEXT[current]
    except KeyError as exc:
        raise ValueError(f"{current.value} 没有下一处理阶段") from exc


def can_publish(*, actor_kind: str, decision_comment: str) -> bool:
    return actor_kind == "HUMAN" and bool(decision_comment.strip())


def require_human_decision(current: Authority, proposed: Authority, *, actor_kind: str) -> Authority:
    levels = list(Authority)
    if actor_kind == "AI" and levels.index(proposed) > levels.index(current):
        raise ValueError("AI 无权提高来源权威")
    return proposed
```

- [ ] **Step 4: 运行领域测试确认通过**

Run: `cd backend && uv run pytest test/unit/governance/test_domain.py -v`

Expected: 4 tests PASS。

- [ ] **Step 5: 提交领域规则**

```bash
git add backend/package/yuxi/governance backend/test/unit/governance/test_domain.py
git commit -m "feat: define governance domain rules"
```

### Task 3: 建立治理模型与首个迁移

**Files:**
- Modify: `backend/package/yuxi/governance/models.py`
- Create: `backend/alembic/versions/20260812_0001_governance_core.py`
- Test: `backend/test/integration/governance/test_migrations.py`
- Test: `backend/test/integration/governance/test_immutability.py`

- [ ] **Step 1: 写迁移失败测试**

Create `backend/test/integration/governance/test_migrations.py`:

```python
import os

import pytest
from sqlalchemy import inspect
from sqlalchemy.ext.asyncio import create_async_engine

EXPECTED = {
    "governance_user_roles",
    "governance_source_roots", "governance_assets", "governance_asset_revisions",
    "governance_sections", "governance_candidates", "governance_reviews",
    "governance_knowledge", "governance_knowledge_versions",
    "governance_knowledge_version_sources", "governance_version_indexes", "governance_version_access",
    "governance_access_policies",
    "governance_jobs", "governance_outbox",
}


@pytest.mark.integration
async def test_governance_migration_creates_all_tables():
    engine = create_async_engine(os.environ["POSTGRES_URL"])
    async with engine.connect() as conn:
        tables = set(await conn.run_sync(lambda sync: inspect(sync).get_table_names()))
    await engine.dispose()
    assert EXPECTED <= tables
```

- [ ] **Step 2: 写完整 SQLAlchemy 模型**

Modify `backend/package/yuxi/governance/models.py`。所有表继承 `yuxi.governance.models.GovernanceBase`，ID 使用 `String(26)` ULID；所有时间为带时区 `DateTime(timezone=True)`。模型必须包含以下列和约束。`owner_uid/reviewer_uid/default_owner_uid` 使用 `String(64)` 并由 Repository 校验 Yuxi 用户存在，不创建跨 metadata 外键：

```text
governance_user_roles:
  id, user_uid(unique), platform_role, created_at, updated_at

governance_source_roots:
  id, provider, root_token(unique), root_url, default_owner_uid, default_authority,
  enabled, created_at, updated_at

governance_assets:
  id, source_root_id(FK), provider, node_token, obj_token, obj_type, parent_node_token,
  full_path, title, source_url, owner_uid, authority, lifecycle, current_revision_id,
  source_modified_at, created_at, updated_at
  UNIQUE(source_root_id,node_token)

governance_asset_revisions:
  id, asset_id(FK), revision_no, content_hash, source_modified_at, synced_at,
  raw_object_key, parsed_object_key, parser_name, parser_version, stage,
  failed_stage, error_code, error_message, retry_count, execution_config,
  created_at
  UNIQUE(asset_id,revision_no), UNIQUE(asset_id,content_hash)

governance_sections:
  id, revision_id(FK), ordinal, heading, content, source_locator, block_id,
  page_no, char_start, char_end, content_hash, created_at
  UNIQUE(revision_id,ordinal)

governance_candidates:
  id, revision_id(FK), section_id(FK), title, normalized_content, knowledge_type,
  subject, conditions, conclusion, effective_constraints, source_excerpt,
  source_locator, authority, confidence, relation, compared_knowledge_id,
  ai_reason, model_version, prompt_version, candidate_hash, status, created_at, reviewed_at
  UNIQUE(revision_id,section_id,candidate_hash)

governance_reviews:
  id, review_type, candidate_id(FK nullable), target_knowledge_id(FK nullable),
  current_snapshot, proposed_content, diff, risk, owner_uid, reviewer_uid,
  status, resolution_action, final_content, decision_comment, created_at, completed_at

governance_knowledge:
  id, title, owner_uid, category, tags(JSON), status, ai_enabled,
  active_version_id, pending_version_id, created_at, updated_at

governance_knowledge_versions:
  id, knowledge_id(FK), version_no, content, applicability, valid_from, valid_to,
  review_id(FK), reviewer_uid, decision_comment,
  created_at
  UNIQUE(knowledge_id,version_no)

governance_knowledge_version_sources:
  id, knowledge_version_id(FK), revision_id(FK), section_id(FK), source_role,
  source_locator, source_excerpt, created_at
  UNIQUE(knowledge_version_id,revision_id,section_id)

governance_version_indexes:
  id, knowledge_version_id(FK), index_version, index_model, status,
  collection_name, indexed_at, error_code, error_message, created_at, updated_at
  UNIQUE(knowledge_version_id,index_version)

governance_version_access:
  id, knowledge_version_id(FK unique), access_policy_id(FK), projection_version,
  status, created_at, updated_at

governance_access_policies:
  id, semantic_hash(unique), version, status, projection_version,
  source_clauses(JSON), created_at, invalidated_at

governance_jobs:
  id, job_type, aggregate_type, aggregate_id, idempotency_key(unique), stage,
  status, priority, progress_current, progress_total, attempt_count, max_attempts,
  error_code, error_message, execution_config, next_retry_at, cancel_requested_at,
  started_at, finished_at, created_at, updated_at

governance_outbox:
  id, event_type, aggregate_type, aggregate_id, job_id(FK), payload(JSON),
  priority, available_at, dispatched_at, dispatch_attempts, last_error, created_at
```

在 PostgreSQL 为以下不变量增加 `CHECK`：置信度 0–1、版本号大于 0、尝试数非负、完成 Review 必须有 `reviewer_uid/decision_comment/completed_at`、`VersionIndex.status=INDEXED` 时必须有 `indexed_at/index_model/index_version`。API 将 `Knowledge.active_version_id/pending_version_id/status`、最新 `VersionIndex.status` 和来源有效性组合投影为规格中的 KnowledgeVersion 当前状态；不可变 `KnowledgeVersion` 行本身不承载会变化的发布或索引状态。

- [ ] **Step 3: 生成并审查首个迁移**

Run against disposable integration database:

```bash
cd backend
uv run alembic revision --autogenerate -m "create governance core" --rev-id 20260812_0001
uv run alembic upgrade head
uv run alembic downgrade base
uv run alembic upgrade head
```

Expected: 三个迁移命令退出码 0；生成文件命名为 `20260812_0001_governance_core.py`，`upgrade()` 创建上述 15 张表、索引、治理表内部外键、唯一约束和 CHECK，`downgrade()` 以反向依赖顺序只删除治理表。

- [ ] **Step 4: 写并运行不可变触发器测试**

Create `backend/test/integration/governance/test_immutability.py`，插入一个 Revision 后执行正文更新，并断言 PostgreSQL 抛出 `DBAPIError`；对 `governance_sections`、已完成 `governance_reviews` 和 `governance_knowledge_versions` 做相同断言。

迁移为这四类表创建 `BEFORE UPDATE OR DELETE` 触发器；只允许以下字段例外：Revision 的阶段/失败字段、Candidate 的状态/审核时间。`KnowledgeVersion` 一旦插入完全不可更新；运行态索引状态只更新对应的 `governance_version_indexes` 行，不事后改版本正文。

- [ ] **Step 5: 运行迁移集成测试**

Run:

```bash
cd backend
uv run pytest test/integration/governance/test_migrations.py test/integration/governance/test_immutability.py -m integration -v
```

Expected: 全部 PASS；测试只使用独立 `yuxi_test` 数据库。

- [ ] **Step 6: 提交模型和迁移**

```bash
git add backend/package/yuxi/governance/models.py backend/alembic/versions/20260812_0001_governance_core.py \
  backend/test/integration/governance
git commit -m "feat: persist immutable governance records"
```

### Task 4: 实现事务 Job 与 Outbox

**Files:**
- Create: `backend/package/yuxi/governance/job_repository.py`
- Create: `backend/package/yuxi/governance/job_service.py`
- Test: `backend/test/unit/governance/test_job_service.py`
- Test: `backend/test/integration/governance/test_job_outbox_transaction.py`

- [ ] **Step 1: 写失败单元测试**

Create `backend/test/unit/governance/test_job_service.py`:

```python
from unittest.mock import AsyncMock

import pytest

from yuxi.governance.domain import JobStatus
from yuxi.governance.job_service import JobService


@pytest.mark.asyncio
async def test_create_job_is_idempotent_and_writes_outbox():
    repo = AsyncMock()
    repo.create_with_outbox.side_effect = [({"id": "JOB1"}, True), ({"id": "JOB1"}, False)]
    service = JobService(repo)
    first = await service.enqueue("SYNC_ROOT", "SOURCE_ROOT", "ROOT1", "sync:ROOT1:CURSOR1", {})
    second = await service.enqueue("SYNC_ROOT", "SOURCE_ROOT", "ROOT1", "sync:ROOT1:CURSOR1", {})
    assert first.job["id"] == second.job["id"] == "JOB1"
    assert first.created is True and second.created is False


@pytest.mark.asyncio
async def test_retry_stops_after_five_attempts():
    repo = AsyncMock()
    repo.record_failure.return_value = {"status": JobStatus.NEEDS_ATTENTION, "attempt_count": 5}
    result = await JobService(repo).fail("JOB1", "FEISHU_RATE_LIMIT", "限流")
    assert result["status"] is JobStatus.NEEDS_ATTENTION
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && uv run pytest test/unit/governance/test_job_service.py -v`

Expected: FAIL，原因是模块不存在。

- [ ] **Step 3: 实现 Repository 的原子操作**

`JobRepository.create_with_outbox()` 必须在调用方传入的同一个 `AsyncSession` 中：

1. 按 `idempotency_key` 查询现有 Job；存在则返回 `(job, False)`。
2. 插入 `Job(status=PENDING,max_attempts=5)`。
3. 插入 `Outbox(event_type="JOB_REQUESTED",job_id=job.id,payload={"job_id": job.id})`。
4. `flush()` 但不自行 `commit()`，事务由应用服务统一提交。

同时实现：

```python
async def claim_outbox(self, limit: int = 50) -> list[Outbox]
async def mark_dispatched(self, outbox_id: str, dispatched_at: datetime) -> None
async def mark_running(self, job_id: str, stage: str) -> Job
async def record_failure(self, job_id: str, code: str, message: str, next_retry_at: datetime | None) -> Job
async def mark_succeeded(self, job_id: str) -> Job
async def request_cancel(self, job_id: str) -> Job
async def list_recoverable(self, now: datetime) -> list[Job]
```

`claim_outbox` 使用 `FOR UPDATE SKIP LOCKED`，只取 `dispatched_at IS NULL AND available_at <= now()`，按 `priority DESC, created_at ASC` 排序。

- [ ] **Step 4: 实现 Service 的确定性状态迁移**

`JobService` 暴露：

```python
async def enqueue(job_type, aggregate_type, aggregate_id, idempotency_key, payload, priority=0) -> EnqueueResult
async def start(job_id, stage) -> Job
async def succeed(job_id) -> Job
async def fail(job_id, code, message) -> Job
async def retry(job_id) -> Job
async def cancel(job_id) -> Job
```

临时错误采用 `min(3600, 30 * 2 ** (attempt_count - 1))` 秒退避；第 5 次失败进入 `NEEDS_ATTENTION` 且 `next_retry_at=NULL`。只有 `PENDING/RETRY_WAIT/DISPATCHED` 可取消；取消不删除证据和 Outbox 历史。

- [ ] **Step 5: 写事务回滚集成测试**

Create `backend/test/integration/governance/test_job_outbox_transaction.py`：在创建 Job 与 Outbox 后主动抛出异常并回滚，断言两表均无记录；正常事务断言恰好一个 Job 和一个 Outbox；重复幂等键断言仍各一个。

- [ ] **Step 6: 运行全部 Job 测试**

Run:

```bash
cd backend
uv run pytest test/unit/governance/test_job_service.py -v
uv run pytest test/integration/governance/test_job_outbox_transaction.py -m integration -v
```

Expected: 全部 PASS。

- [ ] **Step 7: 提交 Job/Outbox**

```bash
git add backend/package/yuxi/governance/job_repository.py backend/package/yuxi/governance/job_service.py \
  backend/test/unit/governance/test_job_service.py backend/test/integration/governance/test_job_outbox_transaction.py
git commit -m "feat: add durable governance jobs and outbox"
```

### Task 5: 接入 ARQ dispatcher 与治理 Worker

**Files:**
- Create: `backend/package/yuxi/governance/dispatcher.py`
- Create: `backend/package/yuxi/governance/worker.py`
- Modify: `backend/package/yuxi/services/run_worker.py`
- Test: `backend/test/unit/governance/test_dispatcher.py`
- Test: `backend/test/integration/governance/test_job_recovery.py`

- [ ] **Step 1: 写失败 dispatcher 测试**

Create `backend/test/unit/governance/test_dispatcher.py`:

```python
from unittest.mock import AsyncMock

import pytest

from yuxi.governance.dispatcher import dispatch_pending_outbox


@pytest.mark.asyncio
async def test_dispatcher_marks_only_successfully_enqueued_events():
    repo = AsyncMock()
    repo.claim_outbox.return_value = [
        {"id": "O1", "job_id": "J1"}, {"id": "O2", "job_id": "J2"}
    ]
    queue = AsyncMock()
    queue.enqueue_job.side_effect = [object(), ConnectionError("redis down")]
    await dispatch_pending_outbox(repo, queue)
    repo.mark_dispatched.assert_awaited_once()
    assert repo.mark_dispatch_failed.await_count == 1
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && uv run pytest test/unit/governance/test_dispatcher.py -v`

Expected: FAIL，原因是 dispatcher 不存在。

- [ ] **Step 3: 实现 dispatcher**

`dispatch_pending_outbox(repo, queue)` 逐条调用：

```python
await queue.enqueue_job(
    "process_governance_job",
    event.job_id,
    _job_id=f"governance:{event.job_id}",
    _queue_name="arq:queue:governance",
)
```

只有 enqueue 成功才 `mark_dispatched`；Redis 异常只增加 Outbox `dispatch_attempts/last_error`，不把 Job 标成失败。增加 `recover_undispatched_jobs()`：为没有待投递 Outbox 的 `PENDING/RETRY_WAIT` Job 补写 Outbox。

- [ ] **Step 4: 实现统一 Worker 入口**

Create `backend/package/yuxi/governance/worker.py`:

```python
HANDLERS = {}


def register_handler(job_type: str, handler):
    HANDLERS[job_type] = handler


async def process_governance_job(ctx, job_id: str):
    service = ctx["governance_job_service"]
    job = await service.start(job_id, stage="STARTING")
    if job.cancel_requested_at:
        return await service.cancel(job_id)
    handler = HANDLERS.get(job.job_type)
    if handler is None:
        return await service.fail(job_id, "UNKNOWN_JOB_TYPE", job.job_type)
    try:
        await handler(ctx, job)
    except Exception as exc:
        if service.is_retryable(exc):
            return await service.fail(job_id, service.error_code(exc), str(exc))
        return await service.fail_permanently(job_id, service.error_code(exc), str(exc))
    return await service.succeed(job_id)
```

在 `yuxi.services.run_worker.WorkerSettings.functions` 中加入 `process_governance_job`；启动时初始化治理 repository/service，调用 `recover_undispatched_jobs()` 和 `dispatch_pending_outbox()`。将 `max_tries` 保持 2 仅用于 ARQ 传输故障，业务最多五次由 PostgreSQL Job 控制。

- [ ] **Step 5: 写 Redis 清空恢复集成测试**

Create `backend/test/integration/governance/test_job_recovery.py`：创建三个 PENDING Job，清空 Redis queue，运行恢复函数两次；断言每个 Job 只有一个未完成 Outbox 且 ARQ 使用稳定 `_job_id`；启动 Worker 后三个 Job 最终 SUCCEEDED。

- [ ] **Step 6: 运行 dispatcher 和恢复测试**

Run:

```bash
cd backend
uv run pytest test/unit/governance/test_dispatcher.py -v
uv run pytest test/integration/governance/test_job_recovery.py -m integration -v
```

Expected: 全部 PASS。

- [ ] **Step 7: 提交可靠 Worker**

```bash
git add backend/package/yuxi/governance/dispatcher.py backend/package/yuxi/governance/worker.py \
  backend/package/yuxi/services/run_worker.py backend/test/unit/governance/test_dispatcher.py \
  backend/test/integration/governance/test_job_recovery.py
git commit -m "feat: recover governance jobs through arq"
```

### Task 6: 建立治理查询与任务 API 边界

**Files:**
- Create: `backend/package/yuxi/governance/schemas.py`
- Create: `backend/package/yuxi/governance/repository.py`
- Create: `backend/package/yuxi/governance/service.py`
- Create: `backend/server/routers/governance_router.py`
- Modify: `backend/server/routers/__init__.py`
- Test: `backend/test/unit/governance/test_governance_router.py`

- [ ] **Step 1: 写失败路由测试**

Create `backend/test/unit/governance/test_governance_router.py`:

```python
from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.routers.governance_router import router


def test_governance_routes_have_stable_prefixes():
    app = FastAPI()
    app.include_router(router, prefix="/api")
    paths = {route.path for route in app.routes}
    assert "/api/governance/jobs" in paths
    assert "/api/governance/assets" in paths
    assert "/api/governance/candidates" in paths
    assert "/api/governance/reviews" in paths
    assert "/api/governance/knowledge" in paths


def test_anonymous_user_cannot_list_jobs(app_with_overrides):
    response = TestClient(app_with_overrides).get("/api/governance/jobs")
    assert response.status_code == 401
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && uv run pytest test/unit/governance/test_governance_router.py -v`

Expected: FAIL，原因是 router 不存在。

- [ ] **Step 3: 定义稳定响应 Schema**

在 `schemas.py` 定义：

```python
class Page(BaseModel):
    items: list[dict]
    next_cursor: str | None = None


class JobRetryRequest(BaseModel):
    reason: str = Field(min_length=2, max_length=500)


class ErrorBody(BaseModel):
    code: str
    message: str
    request_id: str
```

所有列表使用 `cursor + limit(1..100)`，不使用页码偏移；详情不存在返回 `404 GOVERNANCE_NOT_FOUND`；非法状态迁移返回 `409 INVALID_STATE_TRANSITION`。

- [ ] **Step 4: 实现最小查询服务和路由**

创建以下路由；阶段 2 对 sources 同步和业务写操作仅返回尚未配置的明确状态，不伪造数据：

```text
GET  /api/governance/jobs
GET  /api/governance/jobs/{job_id}
POST /api/governance/jobs/{job_id}/retry
POST /api/governance/jobs/{job_id}/cancel
GET  /api/governance/assets
GET  /api/governance/assets/{asset_id}
GET  /api/governance/candidates
GET  /api/governance/reviews
GET  /api/governance/knowledge
GET  /api/governance/knowledge/{knowledge_id}
```

依赖规则：产品权限读取 `governance_user_roles.platform_role`，不复用 Yuxi 原有小写 `users.role`。Jobs 仅 ADMIN；Asset/Candidate/Review 列表仅 KNOWLEDGE_OWNER/ADMIN；Knowledge Owner 只能看到 `owner_uid` 为自己的治理记录；LOCAL_SUPERADMIN 能看系统 Job 元数据，但不能通过这些接口获取未授权正文。Yuxi 原有 `users.role=user|admin|superadmin` 只服务技术后台兼容性。

在 `server/routers/__init__.py` 增加：

```python
from server.routers.governance_router import router as governance_router
router.include_router(governance_router)
```

- [ ] **Step 5: 补齐角色与游标测试**

测试以下矩阵：匿名 401；EMPLOYEE 访问治理列表 403；KNOWLEDGE_OWNER 只看到自己的对象；ADMIN 看到全部；limit=101 返回 422；无效 cursor 返回 400；LOCAL_SUPERADMIN 的 Asset 详情正文被 403。

- [ ] **Step 6: 运行路由测试**

Run: `cd backend && uv run pytest test/unit/governance/test_governance_router.py -v`

Expected: 全部 PASS。

- [ ] **Step 7: 提交 API 骨架**

```bash
git add backend/package/yuxi/governance/schemas.py backend/package/yuxi/governance/repository.py \
  backend/package/yuxi/governance/service.py backend/server/routers/governance_router.py \
  backend/server/routers/__init__.py backend/test/unit/governance/test_governance_router.py
git commit -m "feat: expose governed knowledge resources"
```

### Task 7: 阶段 2 整体验收

**Files:**
- Modify: `docs/implementation/acceptance-log.md`

- [ ] **Step 1: 从空测试库验证迁移往返**

Run:

```bash
cd backend
POSTGRES_URL="$TEST_POSTGRES_URL" uv run alembic downgrade base
POSTGRES_URL="$TEST_POSTGRES_URL" uv run alembic upgrade head
POSTGRES_URL="$TEST_POSTGRES_URL" uv run alembic current
```

Expected: current revision 为 `20260812_0001 (head)`；只操作明确的 `yuxi_test` 数据库，若 URL 库名不是 `yuxi_test` 则停止。

- [ ] **Step 2: 运行阶段测试集**

Run:

```bash
cd backend
uv run pytest test/unit/governance -v
uv run pytest test/integration/governance -m integration -v
uv run ruff check package/yuxi/governance server/routers/governance_router.py test/unit/governance
```

Expected: 全部退出码 0。

- [ ] **Step 3: 验证 PostgreSQL 是唯一写入事实**

停止 PostgreSQL，调用创建 Job 或治理写接口；验证返回 503 且当前工程/新工程均没有生成 JSON 数据文件。恢复 PostgreSQL 后验证 Outbox 重新投递。

Expected: 不发生本地 JSON 降级；已有记录不丢失。

- [ ] **Step 4: 验证 API/Worker 迁移门禁**

人为在测试库制造旧 revision，启动 Compose；验证 `migrate` 先完成，随后 API/Worker 启动。制造无效迁移时，API/Worker 不启动而不是带错表运行。

- [ ] **Step 5: 更新记录并提交**

把迁移、不可变、角色隔离、Outbox 原子性、Redis 恢复和 PostgreSQL 故障行为逐项记为 PASS。

```bash
git add docs/implementation/acceptance-log.md
git commit -m "docs: accept governance backend milestone"
```

Expected: 阶段 2 结论为 PASS；只有此提交存在后才进入飞书接入阶段。
