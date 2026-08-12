# 飞书登录、Wiki 同步与 ACL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 接入真实企业飞书，实现员工 OAuth 登录、指定 Wiki 根节点递归/增量/对账同步、不可变证据版本，以及检索前默认拒绝的来源 ACL 投影。

**Architecture:** `FeishuClient` 封装开放平台 HTTP 调用，纯同步规划器把远端节点快照转换成幂等动作，持久 Job 分别执行扫描、下载、解析和 ACL 更新。OAuth 身份、组织成员关系和来源 ACL 存入 PostgreSQL，`AccessPolicyService` 计算稳定策略 ID；撤权、移出和删除以高优先级 Outbox 先让策略失效，再异步更新索引投影。

**Tech Stack:** FastAPI、httpx、Pydantic、SQLAlchemy、Alembic、PostgreSQL、ARQ、MinIO、Yuxi 文档解析/RapidOCR、飞书开放平台 OAuth/Wiki/Drive/Docx API、pytest-httpx。

---

## 文件结构

```text
KnowledgeBase-Yuxi/backend/
├── alembic/versions/20260812_0002_feishu_sync_acl.py
├── package/yuxi/integrations/feishu/
│   ├── __init__.py
│   ├── config.py                 # 环境配置和固定根节点
│   ├── schemas.py                # 飞书响应的最小稳定 Schema
│   ├── token_vault.py            # OAuth token 加密
│   ├── client.py                 # 开放平台 HTTP 适配器
│   ├── oauth_service.py          # state、回调、身份映射
│   ├── sync_planner.py           # 远端/本地快照 -> 幂等动作
│   ├── sync_service.py           # 全量、事件、每日对账
│   ├── content_service.py        # 导出、MinIO、解析、Section
│   ├── acl_service.py            # ACL 规范化、交集和 fail-closed
│   └── jobs.py                   # ARQ handler 注册
├── package/yuxi/governance/
│   └── models.py
├── server/routers/
│   ├── feishu_auth_router.py
│   ├── feishu_event_router.py
│   └── governance_source_router.py
└── test/
    ├── fixtures/feishu/
    │   ├── child_page_1.json
    │   ├── child_page_2.json
    │   ├── docx_node.json
    │   ├── acl_members.json
    │   └── event_doc_updated.json
    ├── unit/feishu/
    │   ├── test_client.py
    │   ├── test_oauth_service.py
    │   ├── test_sync_planner.py
    │   ├── test_content_service.py
    │   └── test_acl_service.py
    ├── integration/feishu/
    │   ├── test_sync_pipeline.py
    │   ├── test_event_reconciliation.py
    │   └── test_acl_revocation.py
    └── e2e/feishu/
        └── test_real_root_readonly.py
```

### Task 1: 增加飞书配置、身份和 ACL 数据结构

**Files:**
- Modify: `.env.example`
- Create: `backend/alembic/versions/20260812_0002_feishu_sync_acl.py`
- Modify: `backend/package/yuxi/governance/models.py`
- Test: `backend/test/integration/feishu/test_feishu_migration.py`

- [ ] **Step 1: 写失败迁移测试**

Create `backend/test/integration/feishu/test_feishu_migration.py`:

```python
import os

import pytest
from sqlalchemy import inspect
from sqlalchemy.ext.asyncio import create_async_engine


@pytest.mark.integration
async def test_feishu_migration_adds_identity_sync_and_acl_tables():
    engine = create_async_engine(os.environ["POSTGRES_URL"])
    expected = {
        "feishu_identities", "feishu_oauth_credentials", "feishu_org_memberships",
        "feishu_sync_runs", "feishu_event_inbox", "source_acl_snapshots",
        "source_acl_bindings", "access_policy_sources",
    }
    async with engine.connect() as conn:
        tables = set(await conn.run_sync(lambda sync: inspect(sync).get_table_names()))
    await engine.dispose()
    assert expected <= tables
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && uv run pytest test/integration/feishu/test_feishu_migration.py -m integration -v`

Expected: FAIL，列出的飞书表不存在。

- [ ] **Step 3: 扩展本机配置模板**

Append to `.env.example`:

```dotenv
FEISHU_APP_ID=
FEISHU_APP_SECRET=
FEISHU_OAUTH_REDIRECT_URI=http://127.0.0.1:5050/api/auth/feishu/callback
FEISHU_EVENT_VERIFICATION_TOKEN=
FEISHU_EVENT_ENCRYPT_KEY=
FEISHU_TOKEN_ENCRYPTION_KEY=
FEISHU_WIKI_ROOT_TOKEN=VO95wRtWri5XoNkKqU0cLjQ3nqc
FEISHU_API_BASE=https://open.feishu.cn
FEISHU_TENANT_DOMAIN=quickdone.feishu.cn
```

`FEISHU_TOKEN_ENCRYPTION_KEY` 使用 `cd backend && uv run python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'` 在用户本机生成并只写 `.env`。其他真实值由用户从已有飞书应用配置录入；不得通过聊天传递。

- [ ] **Step 4: 定义模型和迁移**

迁移 `20260812_0002` 创建：

```text
feishu_identities:
  id, user_uid(unique), open_id(unique), union_id(unique nullable),
  user_id(nullable), tenant_key, display_name, avatar_url, status, last_synced_at,
  created_at, updated_at

feishu_oauth_credentials:
  id, identity_id(FK unique), encrypted_access_token, encrypted_refresh_token,
  access_expires_at, refresh_expires_at, scopes(JSON), updated_at

feishu_org_memberships:
  id, identity_id(FK), principal_type(USER|DEPARTMENT|TENANT), principal_id,
  source_version, active, synced_at
  UNIQUE(identity_id,principal_type,principal_id)

feishu_sync_runs:
  id, source_root_id(FK), trigger(MANUAL|EVENT|RECONCILIATION), status,
  cursor, discovered_count, created_count, updated_count, deleted_count,
  failed_count, skipped_count, started_at, finished_at, error_code, error_message

feishu_event_inbox:
  id, event_id(unique), event_type, resource_token, event_created_at,
  payload(JSON), status, received_at, processed_at

source_acl_snapshots:
  id, revision_id(FK), provider_version, semantic_hash, status,
  captured_at, error_code, error_message

source_acl_bindings:
  id, snapshot_id(FK), principal_type(USER|DEPARTMENT|SPACE|TENANT),
  principal_id, permission(READ), created_at
  UNIQUE(snapshot_id,principal_type,principal_id)

access_policy_sources:
  id, access_policy_id(FK), revision_id(FK), acl_snapshot_id(FK),
  created_at
  UNIQUE(access_policy_id,revision_id)
```

为 `governance_source_roots` 增加 `space_id`、`last_successful_cursor`、`last_reconciled_at`、`acl_projection_version`；为 `governance_assets` 增加 `last_seen_sync_run_id`。OAuth 密文列不可为空，数据库不得保存明文 token。

同时为 `governance_asset_revisions` 增加可空 `acl_snapshot_id`，并在同一迁移创建 `source_acl_snapshots` 后补上治理表内部外键；阶段 2 不预建指向尚不存在表的外键。

- [ ] **Step 5: 执行迁移往返与测试**

Run:

```bash
cd backend
uv run alembic upgrade head
uv run pytest test/integration/feishu/test_feishu_migration.py -m integration -v
uv run alembic downgrade 20260812_0001
uv run alembic upgrade head
```

Expected: 测试 PASS；往返无错误；生产数据环境不运行 downgrade。

- [ ] **Step 6: 提交结构变更**

```bash
git add .env.example backend/package/yuxi/governance/models.py \
  backend/alembic/versions/20260812_0002_feishu_sync_acl.py backend/test/integration/feishu/test_feishu_migration.py
git commit -m "feat: persist feishu identities sync and acl"
```

### Task 2: 实现最小飞书 HTTP Client

**Files:**
- Create: `backend/package/yuxi/integrations/feishu/__init__.py`
- Create: `backend/package/yuxi/integrations/feishu/config.py`
- Create: `backend/package/yuxi/integrations/feishu/schemas.py`
- Create: `backend/package/yuxi/integrations/feishu/client.py`
- Test: `backend/test/unit/feishu/test_client.py`
- Create: `backend/test/fixtures/feishu/child_page_1.json`
- Create: `backend/test/fixtures/feishu/child_page_2.json`

- [ ] **Step 1: 写分页、限流和错误分类失败测试**

Create `backend/test/unit/feishu/test_client.py`:

```python
import httpx
import pytest

from yuxi.integrations.feishu.client import FeishuClient, FeishuPermissionDenied, FeishuRateLimited


@pytest.mark.asyncio
async def test_list_all_children_follows_page_token(httpx_mock):
    httpx_mock.add_response(json={"code": 0, "data": {"items": [{"node_token": "N1"}], "has_more": True, "page_token": "P2"}})
    httpx_mock.add_response(json={"code": 0, "data": {"items": [{"node_token": "N2"}], "has_more": False}})
    client = FeishuClient("https://open.feishu.cn", "app", "secret")
    assert [item.node_token for item in await client.list_all_children("SPACE", "ROOT")] == ["N1", "N2"]
    assert httpx_mock.get_requests()[1].url.params["page_token"] == "P2"


@pytest.mark.asyncio
async def test_rate_limit_is_retryable(httpx_mock):
    httpx_mock.add_response(status_code=429, headers={"Retry-After": "2"})
    with pytest.raises(FeishuRateLimited) as error:
        await FeishuClient("https://open.feishu.cn", "app", "secret").get_node("ROOT")
    assert error.value.retry_after_seconds == 2


@pytest.mark.asyncio
async def test_explicit_permission_denial_is_not_reported_as_missing(httpx_mock):
    httpx_mock.add_response(status_code=403, json={"code": 99991672, "msg": "no permission"})
    with pytest.raises(FeishuPermissionDenied):
        await FeishuClient("https://open.feishu.cn", "app", "secret").get_node("ROOT")
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && uv run pytest test/unit/feishu/test_client.py -v`

Expected: FAIL，飞书模块不存在。

- [ ] **Step 3: 定义最小响应 Schema**

`schemas.py` 定义 `WikiNode`：`node_token,obj_token,obj_type,parent_node_token,title,space_id,has_child,origin_node_token,creator,owner,create_time,obj_create_time,obj_edit_time,node_create_time`，未知字段使用 `extra="ignore"`。定义 `PermissionMember`：`member_type,member_id,perm,perm_type`。

拒绝把完整开放平台响应存入数据库；只保留业务需要字段和脱敏错误码。

- [ ] **Step 4: 实现明确 API 操作**

`FeishuClient` 使用共享 `httpx.AsyncClient(timeout=30)`，实现：

```python
async def get_tenant_access_token() -> str
async def exchange_oauth_code(code: str, redirect_uri: str) -> OAuthToken
async def refresh_oauth_token(refresh_token: str) -> OAuthToken
async def get_current_user(user_access_token: str) -> FeishuUser
async def get_node(token: str) -> WikiNode
async def list_children(space_id: str, parent_node_token: str, page_token: str | None = None) -> NodePage
async def list_all_children(space_id: str, parent_node_token: str) -> list[WikiNode]
async def get_docx_raw_content(document_id: str) -> str
async def get_docx_blocks(document_id: str, page_token: str | None = None) -> BlockPage
async def download_media(file_token: str) -> AsyncIterator[bytes]
async def list_permission_members(token: str, resource_type: str, page_token: str | None = None) -> PermissionPage
async def get_public_permission(token: str, resource_type: str) -> PublicPermission
async def probe_user_access(node_token: str, user_access_token: str) -> bool
```

固定路径：

```text
POST /open-apis/auth/v3/tenant_access_token/internal
POST /open-apis/authen/v2/oauth/token
GET  /open-apis/authen/v1/user_info
GET  /open-apis/wiki/v2/spaces/get_node?token={token}
GET  /open-apis/wiki/v2/spaces/{space_id}/nodes
GET  /open-apis/docx/v1/documents/{document_id}/raw_content
GET  /open-apis/docx/v1/documents/{document_id}/blocks
GET  /open-apis/drive/v1/medias/{file_token}/download
GET  /open-apis/drive/v1/permissions/{token}/members?type={resource_type}
GET  /open-apis/drive/v2/permissions/{token}/public?type={resource_type}
```

收到 HTTP 429 或飞书频控 code 时抛 `FeishuRateLimited`；401/token 失效抛 `FeishuTokenExpired`；403/明确无权限抛 `FeishuPermissionDenied`；5xx/超时抛 `FeishuTemporarilyUnavailable`；其他非零 code 抛 `FeishuApiError(code,request_id)`。日志不得包含 Authorization、App Secret、正文或 token。

- [ ] **Step 5: 补齐分页和协议测试**

使用 `pytest-httpx` 验证每个方法的 HTTP method、path、query、Bearer token、非零 code 分类、30 秒超时以及最多 50 的 Wiki `page_size`。验证正文只由调用者处理，不写日志。

- [ ] **Step 6: 运行飞书 Client 测试**

Run: `cd backend && uv run pytest test/unit/feishu/test_client.py -v`

Expected: 全部 PASS，无真实网络请求。

- [ ] **Step 7: 提交 Client**

```bash
git add backend/package/yuxi/integrations/feishu backend/test/unit/feishu/test_client.py backend/test/fixtures/feishu
git commit -m "feat: add bounded feishu api client"
```

### Task 3: 实现飞书 OAuth 登录与本地应急管理员边界

**Files:**
- Create: `backend/package/yuxi/integrations/feishu/token_vault.py`
- Create: `backend/package/yuxi/integrations/feishu/oauth_service.py`
- Create: `backend/server/routers/feishu_auth_router.py`
- Modify: `backend/server/routers/__init__.py`
- Test: `backend/test/unit/feishu/test_oauth_service.py`
- Test: `backend/test/unit/feishu/test_auth_router.py`

- [ ] **Step 1: 写 state、防明文和身份映射失败测试**

测试必须断言：OAuth state 单次使用且 10 分钟过期；回调的 tenant_key 不一致时拒绝；数据库密文不包含原 access token；同一 open_id 复用同一 Yuxi User；首次用户默认 `EMPLOYEE`；本地超级管理员没有 `feishu_identity` 时不能读取来源正文。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && uv run pytest test/unit/feishu/test_oauth_service.py test/unit/feishu/test_auth_router.py -v`

Expected: FAIL，OAuth 服务和路由不存在。

- [ ] **Step 3: 实现 TokenVault 和 OAuthService**

`TokenVault` 使用 `cryptography.fernet.Fernet(os.environ["FEISHU_TOKEN_ENCRYPTION_KEY"])` 加解密；禁止默认 key。`OAuthService`：

1. 生成 32 字节随机 state，将 state 哈希、创建时间和原始回跳路径放 Redis，TTL 600 秒。
2. 构造 `https://accounts.feishu.cn/open-apis/authen/v1/authorize` URL，参数仅含 `app_id,redirect_uri,state`。
3. 回调时原子 `GETDEL` state；交换 token；获取当前用户。
4. 验证唯一企业 tenant；upsert `feishu_identities`、Yuxi `users` 和加密 credential。
5. Yuxi `users.role` 对飞书员工保持 `user`，另在 `governance_user_roles.platform_role` 为已分配人员保留 ADMIN/KNOWLEDGE_OWNER，未知用户默认 EMPLOYEE；本地 Yuxi `superadmin` 映射为 LOCAL_SUPERADMIN。
6. 签发 Yuxi 现有 HttpOnly 会话；URL、日志和响应不出现 access/refresh token。

- [ ] **Step 4: 实现路由**

```text
GET  /api/auth/feishu/login?return_to=/chat
GET  /api/auth/feishu/callback?code={oauth_code}&state={oauth_state}
POST /api/auth/feishu/logout
GET  /api/auth/feishu/session
```

`return_to` 只允许同源 `/chat` 或 `/factory` 下的子路径；回调错误返回中文错误码，不回显 code。会话响应：`uid,display_name,avatar_url,role,feishu_connected`。

- [ ] **Step 5: 运行 OAuth 测试**

Run: `cd backend && uv run pytest test/unit/feishu/test_oauth_service.py test/unit/feishu/test_auth_router.py -v`

Expected: 全部 PASS。

- [ ] **Step 6: 提交 OAuth**

```bash
git add backend/package/yuxi/integrations/feishu/token_vault.py backend/package/yuxi/integrations/feishu/oauth_service.py \
  backend/server/routers/feishu_auth_router.py backend/server/routers/__init__.py backend/test/unit/feishu
git commit -m "feat: authenticate employees through feishu"
```

### Task 4: 实现纯同步规划器和 1000 节点递归扫描

**Files:**
- Create: `backend/package/yuxi/integrations/feishu/sync_planner.py`
- Create: `backend/package/yuxi/integrations/feishu/sync_service.py`
- Test: `backend/test/unit/feishu/test_sync_planner.py`
- Test: `backend/test/unit/feishu/test_large_tree.py`

- [ ] **Step 1: 写变更矩阵失败测试**

`test_sync_planner.py` 用表驱动覆盖：新增→CREATE_ASSET；正文时间/哈希变化→CREATE_REVISION；仅标题变化→UPDATE_METADATA；根内移动→UPDATE_PATH；上次存在本次完整对账未见→MARK_MOVED_OUT；暂时 API 失败→NO_DELETE；已删除恢复→RESTORE_AND_REVISE；重复 node_token→只保留一个动作。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && uv run pytest test/unit/feishu/test_sync_planner.py -v`

Expected: FAIL，规划器不存在。

- [ ] **Step 3: 实现确定性动作模型**

定义：

```python
class SyncActionType(StrEnum):
    CREATE_ASSET = "CREATE_ASSET"
    CREATE_REVISION = "CREATE_REVISION"
    UPDATE_METADATA = "UPDATE_METADATA"
    UPDATE_PATH = "UPDATE_PATH"
    MARK_MOVED_OUT = "MARK_MOVED_OUT"
    RESTORE_AND_REVISE = "RESTORE_AND_REVISE"
    MARK_UNSUPPORTED = "MARK_UNSUPPORTED"
    NOOP = "NOOP"
```

`plan_sync(remote_nodes, local_assets, run_complete)` 是纯函数。只有 `run_complete=True` 才能对未见节点产生 `MARK_MOVED_OUT`；网络/权限/分页失败一律 `run_complete=False`。

- [ ] **Step 4: 实现 BFS 递归扫描与断点**

`SyncService.scan_root(root_id, resume_cursor)` 使用队列保存 `(space_id,node_token,path)`；每取完一页就把页 token 和待扫描队列序列化到 `feishu_sync_runs.cursor`。业务幂等键：

```text
scan:{root_id}:{trigger}:{event_id_or_yyyymmdd}
fetch:{asset_id}:{source_modified_at}
acl:{revision_id}:{provider_version}
```

单节点失败记录子 Job 并继续；只有全部分页成功才执行移出判定。

- [ ] **Step 5: 写 1000 节点测试**

生成 10 层、每层混合分页的 1000 个内存节点，注入第 437 个节点一次超时并从游标恢复。断言：1000 个稳定 node_token 恰好处理一次；最大并发不超过 5；恢复不重建已成功 Revision；失败节点独立重试；扫描统计总和一致。

- [ ] **Step 6: 运行同步规划测试**

Run:

```bash
cd backend
uv run pytest test/unit/feishu/test_sync_planner.py test/unit/feishu/test_large_tree.py -v
```

Expected: 全部 PASS。

- [ ] **Step 7: 提交规划和扫描**

```bash
git add backend/package/yuxi/integrations/feishu/sync_planner.py \
  backend/package/yuxi/integrations/feishu/sync_service.py backend/test/unit/feishu/test_sync_planner.py \
  backend/test/unit/feishu/test_large_tree.py
git commit -m "feat: scan feishu wiki recursively and idempotently"
```

### Task 5: 保存不可变证据并生成 Section

**Files:**
- Create: `backend/package/yuxi/integrations/feishu/content_service.py`
- Test: `backend/test/unit/feishu/test_content_service.py`
- Test: `backend/test/integration/feishu/test_sync_pipeline.py`

- [ ] **Step 1: 写内容类型与幂等失败测试**

覆盖：Docx raw content + blocks；PDF/Word/PPT/Excel/Markdown/TXT 下载；图片 RapidOCR；文字会议纪要；复杂 Bitable 标 UNSUPPORTED；音视频标 UNSUPPORTED 且原因 `PHASE2_ASR_REQUIRED`；同一内容 hash 不创建第二 Revision；重命名不重复下载；一个文件解析失败不阻塞其他文件。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && uv run pytest test/unit/feishu/test_content_service.py -v`

Expected: FAIL，内容服务不存在。

- [ ] **Step 3: 实现证据对象键和流式下载**

MinIO key 固定：

```text
evidence/{asset_id}/revisions/{revision_no}/raw/{safe_filename}
evidence/{asset_id}/revisions/{revision_no}/parsed/content.md
evidence/{asset_id}/revisions/{revision_no}/parsed/locations.json
```

文件名只保留最后路径段，去除控制字符，最长 180 字符；下载边读取边 SHA-256，单文件默认上限 200 MiB；超限标 `FILE_TOO_LARGE`，不在内存聚合。MinIO 写成功后才提交 Revision 元数据；失败删除未引用的临时对象。

- [ ] **Step 4: 复用 Yuxi 解析并切 Section**

通过适配器调用 Yuxi 已有文档解析/RapidOCR，将 Markdown 和定位 JSON 存 MinIO。`SectionBuilder` 按标题/段落/表格边界切分，每节保留 `block_id/page_no/char_start/char_end/source_locator/content_hash`；Section 仅写 PostgreSQL，不调用正式知识 indexer。

- [ ] **Step 5: 写全流水线集成测试**

伪造含 Docx、PDF、PNG、音频和 Bitable 的目录，执行两次扫描：断言 Asset 数稳定；Docx/PDF/PNG 有 Revision 和 Section；音频/Bitable 有明确不支持原因且没有 Candidate；第二次扫描没有重复 Revision/Section；修改 Docx 后只新增一个 Revision。

- [ ] **Step 6: 运行内容流水线测试**

Run:

```bash
cd backend
uv run pytest test/unit/feishu/test_content_service.py -v
uv run pytest test/integration/feishu/test_sync_pipeline.py -m integration -v
```

Expected: 全部 PASS。

- [ ] **Step 7: 提交证据处理**

```bash
git add backend/package/yuxi/integrations/feishu/content_service.py backend/test/unit/feishu/test_content_service.py \
  backend/test/integration/feishu/test_sync_pipeline.py
git commit -m "feat: preserve immutable feishu evidence"
```

### Task 6: 实现 ACL 快照、交集与默认拒绝

**Files:**
- Create: `backend/package/yuxi/integrations/feishu/acl_service.py`
- Test: `backend/test/unit/feishu/test_acl_service.py`
- Test: `backend/test/integration/feishu/test_acl_revocation.py`

- [ ] **Step 1: 写 ACL 关系测试**

测试：用户直接授权；部门授权；知识空间成员；企业公开；无绑定；ACL fetch 失败；身份未映射；两来源交集；语义相同策略复用 ID；ACL 版本变化使旧策略先 INVALID；LOCAL_SUPERADMIN 不绕过；历史引用使用当前 ACL。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && uv run pytest test/unit/feishu/test_acl_service.py -v`

Expected: FAIL，ACL 服务不存在。

- [ ] **Step 3: 实现规范化和稳定策略**

`normalize_acl(public_permission,members,space_members)` 为一个来源输出排序去重的允许 principal 子句：`USER:{open_id}`、`DEPARTMENT:{department_id}`、`SPACE:{space_id}` 或 `TENANT:{tenant_key}`。多来源策略把各来源子句按稳定 source ID 排序保存为 `source_clauses`，`semantic_hash=sha256(canonical_json(source_clauses))`。判定逻辑是 `all(user_principals intersects source_clause for source_clause in source_clauses)`；不能直接对不同来源的 principal 字符串集合求交集，否则会误拒“一个来源直接授权用户、另一个来源授权其部门”的合法用户。

`allowed_policy_ids(identity)` 只返回：策略 `status=VALID`、`projection_version` 等于 source root 当前版本、用户当前 principals 满足每一个 `source_clause`，且所有关联来源 lifecycle=ACTIVE/ACL snapshot=VALID 的 ID。任一查询异常返回空集并记录 `ACL_UNAVAILABLE`。

- [ ] **Step 4: 实现撤权优先失效事务**

ACL、组织成员关系、来源移出/删除变化时，同一事务：

1. 把受影响 `AccessPolicy.status` 改为 INVALID。
2. 把引用该策略的 `VersionAccessProjection.status` 改为 INVALID。
3. 增加 root `acl_projection_version`。
4. 写 priority=100 的 `REBUILD_ACCESS_POLICY` Outbox。
5. 重算新策略并把 Milvus entity 的 `access_policy_id` 从旧值更新为新值；只有 Milvus 更新成功后，才把可变 `VersionAccessProjection.access_policy_id/status/projection_version` 切到新策略，不修改不可变 KnowledgeVersion。
6. 让相关正式版本在上述 PostgreSQL 与 Milvus 投影切换完成前不参与召回；Milvus 失败时 projection 保持 INVALID 并重试。

严禁先异步更新 Milvus、后失效 PostgreSQL 策略。

- [ ] **Step 5: 写撤权集成测试**

发布一个两来源测试版本；用户只失去其中一个来源权限后，立即调用 `allowed_policy_ids` 返回空且 citation access 403；随后 Worker 更新 Milvus 元数据。模拟飞书超时同样拒绝，但不得把节点标删除。

- [ ] **Step 6: 运行 ACL 测试**

Run:

```bash
cd backend
uv run pytest test/unit/feishu/test_acl_service.py -v
uv run pytest test/integration/feishu/test_acl_revocation.py -m integration -v
```

Expected: 全部 PASS。

- [ ] **Step 7: 提交 ACL 服务**

```bash
git add backend/package/yuxi/integrations/feishu/acl_service.py backend/test/unit/feishu/test_acl_service.py \
  backend/test/integration/feishu/test_acl_revocation.py
git commit -m "feat: enforce current feishu acl policies"
```

### Task 7: 接入事件、每日对账和管理 API

**Files:**
- Create: `backend/server/routers/feishu_event_router.py`
- Create: `backend/server/routers/governance_source_router.py`
- Modify: `backend/server/routers/__init__.py`
- Modify: `backend/package/yuxi/integrations/feishu/jobs.py`
- Modify: `backend/package/yuxi/services/run_worker.py`
- Test: `backend/test/integration/feishu/test_event_reconciliation.py`
- Test: `backend/test/unit/feishu/test_source_router.py`

- [ ] **Step 1: 写事件重复/乱序/遗漏测试**

测试 URL verification challenge；无效 verification token/signature 401；相同 event_id 只入箱一次；旧事件不会覆盖新 Revision；事件只触发目标节点增量 Job；缺失事件由每日完整对账发现；飞书不可用时保留上次成功 cursor 且不判删除。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && uv run pytest test/integration/feishu/test_event_reconciliation.py -m integration -v`

Expected: FAIL，事件路由不存在。

- [ ] **Step 3: 实现安全事件入口**

`POST /api/integrations/feishu/events` 读取原始 body，用 `X-Lark-Request-Timestamp + X-Lark-Request-Nonce + FEISHU_EVENT_ENCRYPT_KEY + raw_body` 的 SHA-256 与 `X-Lark-Signature` 常量时间比较；同时校验 verification token。若飞书控制台启用加密事件，按官方 AES 解密后再解析；解密失败 401 且不入箱。

URL verification 只返回收到的 `challenge`；普通事件先以 `event_id` 幂等插入 inbox，再返回 200，具体同步异步执行。正文和凭据不写 event payload；只保留事件 ID、类型、资源 token 和时间。

- [ ] **Step 4: 注册 Job 和每日对账**

注册：`SYNC_ROOT`、`SYNC_NODE`、`FETCH_REVISION`、`PARSE_REVISION`、`SYNC_ACL`、`REBUILD_ACCESS_POLICY`。在 ARQ WorkerSettings 增加每天 Asia/Shanghai 02:30 的 cron，只为启用的 root 写 `RECONCILIATION` Job；API 进程不自行启动定时线程。

- [ ] **Step 5: 实现来源管理 API**

```text
POST /api/governance/sources
GET  /api/governance/sources
GET  /api/governance/sources/{root_id}
POST /api/governance/sources/{root_id}/sync
GET  /api/governance/sources/{root_id}/runs
GET  /api/governance/sources/{root_id}/acl-status
```

创建 source body 必须包含固定 root token、默认 `owner_uid` 和默认 `authority`；只有 ADMIN 可操作。若 root token 不等于环境允许值或 owner 不是 KNOWLEDGE_OWNER/ADMIN，返回 422。首次 `sync` 明确区分 `dry_run=true`（只统计 node/type，不下载正文）和正式同步。

- [ ] **Step 6: 运行事件和 API 测试**

Run:

```bash
cd backend
uv run pytest test/integration/feishu/test_event_reconciliation.py -m integration -v
uv run pytest test/unit/feishu/test_source_router.py -v
```

Expected: 全部 PASS。

- [ ] **Step 7: 提交事件与来源 API**

```bash
git add backend/server/routers/feishu_event_router.py backend/server/routers/governance_source_router.py \
  backend/server/routers/__init__.py backend/package/yuxi/integrations/feishu/jobs.py \
  backend/package/yuxi/services/run_worker.py backend/test/integration/feishu/test_event_reconciliation.py \
  backend/test/unit/feishu/test_source_router.py
git commit -m "feat: reconcile feishu events and managed roots"
```

### Task 8: 真实飞书根节点只读验收

**Files:**
- Create: `backend/test/e2e/feishu/test_real_root_readonly.py`
- Modify: `docs/implementation/acceptance-log.md`

- [ ] **Step 1: 写显式 opt-in E2E 测试**

测试仅在 `RUN_REAL_FEISHU_E2E=1` 时运行，断言环境 root token 等于 `VO95wRtWri5XoNkKqU0cLjQ3nqc`；调用 `get_node` 和递归 `dry_run`，记录节点数、深度和 obj_type 统计。测试源码中不得出现 App Secret/token；测试不调用任何 POST/PUT/PATCH/DELETE 飞书资源接口。

- [ ] **Step 2: 先运行默认测试确认真实测试跳过**

Run: `cd backend && uv run pytest test/e2e/feishu/test_real_root_readonly.py -v`

Expected: SKIPPED with `RUN_REAL_FEISHU_E2E is not enabled`。

- [ ] **Step 3: 用户确认飞书应用权限清单**

由用户在飞书开发者后台确认应用已发布到当前企业，OAuth redirect 与事件 URL 精确匹配，并具备 Wiki 节点读取、文档/文件读取、权限成员读取、用户与部门读取权限。只记录权限名称和批准状态，不记录凭据。

- [ ] **Step 4: 执行真实只读 dry-run**

Run from a private shell with `.env` loaded:

```bash
cd backend
RUN_REAL_FEISHU_E2E=1 uv run pytest test/e2e/feishu/test_real_root_readonly.py -m e2e -v
```

Expected: PASS；输出只有节点计数、类型、最大深度和耗时，不输出标题、正文、用户 ID、ACL 成员或 token。

- [ ] **Step 5: 执行受控首次同步**

在管理 API 创建 root，明确选择默认 Knowledge Owner 和 Authority，然后触发正式首次同步。验证：统计可对账；支持资料形成 Revision/Section；音视频显示等待第二阶段；单文件失败不会中止整体；没有飞书写操作。

- [ ] **Step 6: 验证登录和权限撤销样例**

用两个真实测试用户飞书登录；选择一份权限不同的非敏感测试文档，验证有权用户可查看治理来源，无权用户默认拒绝。由飞书管理员临时撤回测试用户权限后触发 ACL 同步，验证引用立即 403；恢复权限后重新同步并恢复访问。

- [ ] **Step 7: 运行阶段完整测试**

Run:

```bash
cd backend
uv run pytest test/unit/feishu -v
uv run pytest test/integration/feishu -m integration -v
uv run ruff check package/yuxi/integrations/feishu server/routers/feishu_*.py server/routers/governance_source_router.py
```

Expected: 全部退出码 0。

- [ ] **Step 8: 签署并提交阶段门禁**

在 `acceptance-log.md` 记录模拟 1000 节点、真实 dry-run、首次同步、OAuth、ACL 交集、撤权阻断和事件/对账结果。

```bash
git add docs/implementation/acceptance-log.md
git commit -m "docs: accept feishu sync and acl milestone"
```

Expected: 阶段 3 为 PASS，提交不含真实正文、用户标识或凭据；只有此提交存在后才进入知识加工与发布。
