# Enterprise Knowledge Assistant Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付可独立上线的“企业知识助手”：员工通过飞书登录，在独立 React 页面直接提问，只依据本人有权访问且已审核发布的企业知识得到带飞书引用的回答。

**Architecture:** React 只调用面向产品的 FastAPI，不再使用旧 Fastify、本地 JSON、本地检索或 Yuxi Agent 页面。FastAPI 以 HttpOnly Cookie 识别飞书用户，从启用的飞书知识源解析唯一目标知识库，先计算可用正式版本和 `yuxi_file_id`，再把文件白名单下推到 Milvus 混合检索；回答、状态、版本和引用在同一 PostgreSQL 事务中保存。Yuxi Vue、Agent、Skill、模型与知识库配置仍保留给管理员，但不出现在普通用户入口。

**Tech Stack:** React 18、TypeScript、Vite、Vitest、Testing Library、FastAPI、Pydantic、SQLAlchemy、PostgreSQL、Redis、Milvus、Yuxi model adapter、飞书 OAuth 2.0。

---

## 实施仓库与边界

- React 产品仓库：`/Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase`
- Yuxi/FastAPI 工作树：`/Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase-Yuxi/.worktrees/feishu-tenant-token-auth`
- 执行时先在 Yuxi 工作树保留 `docs/implementation/acceptance-log.md` 的已有未提交修改，不覆盖、不暂存它。
- React 仓库中的 `.superpowers/` 是本地辅助目录，不加入任何提交。
- 阶段 1 不实现上传按钮、附件 API、临时索引或音视频处理。
- 产品请求不得接受 `kb_id`、模型、Agent、Skill、Top-K、提示词或 `@` 指令。

## 文件结构

```text
KnowledgeBase-Yuxi/backend/
├── package/yuxi/product_chat/
│   ├── __init__.py                       # 产品问答包导出
│   ├── schemas.py                        # 产品 API 和回答结构
│   ├── repository.py                     # 会话、消息、引用事务
│   ├── auth_service.py                   # 飞书 OAuth、一次性 state、身份绑定
│   ├── source_policy_service.py          # 唯一知识源、KB 权限和正式版本白名单
│   ├── answer_service.py                 # 检索、受约束生成和状态校验
│   └── citation_service.py               # 引用读取前二次授权
├── package/yuxi/storage/postgres/
│   ├── models_product.py                 # 产品会话、消息、引用、飞书身份映射
│   └── manager.py                        # 导入模型并补齐幂等 schema
├── package/yuxi/knowledge/implementations/milvus.py
├── server/routers/
│   ├── product_auth_router.py
│   ├── product_chat_router.py
│   ├── product_citation_router.py
│   └── __init__.py
├── server/utils/auth_middleware.py
└── test/{unit,integration,e2e}/product_chat/

KnowledgeBase/
├── shared/api/product.ts                 # 前后端稳定 DTO
├── src/api/client.ts
├── src/session/SessionProvider.tsx
├── src/app/App.tsx
├── src/pages/LoginPage.tsx
├── src/pages/ChatPage.tsx
├── src/components/layout/ProductShell.tsx
├── src/components/chat/{ChatComposer,MessageThread,SourceDrawer}.tsx
├── src/styles/app.css
├── vite.config.ts
└── src/**/*.test.{ts,tsx}
```

### Task 1: 建立产品会话、消息、引用和飞书身份映射

**Files:**
- Create: `backend/package/yuxi/storage/postgres/models_product.py`
- Modify: `backend/package/yuxi/storage/postgres/manager.py`
- Create: `backend/package/yuxi/product_chat/__init__.py`
- Create: `backend/package/yuxi/product_chat/schemas.py`
- Create: `backend/test/unit/product_chat/test_product_models.py`
- Create: `backend/test/integration/product_chat/test_product_schema.py`

- [ ] **Step 1: 写模型和 schema 的失败测试**

在单元测试中断言四张表、唯一约束、外键和回答枚举；在集成测试中调用现有 `create_tables()` 与新增 `ensure_product_schema()`，确认幂等执行两次后列与索引仍正确：

```python
EXPECTED_TABLES = {
    "feishu_user_bindings",
    "product_conversations",
    "product_messages",
    "message_citations",
}

def test_product_tables_share_business_metadata():
    from yuxi.storage.postgres.models_business import Base
    import yuxi.storage.postgres.models_product

    assert EXPECTED_TABLES <= set(Base.metadata.tables)
    assert set(Base.metadata.tables["product_messages"].c.answer_status.type.enums) == {
        "SUPPORTED", "INSUFFICIENT", "CONFLICTING"
    }
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase-Yuxi/.worktrees/feishu-tenant-token-auth/backend
uv run pytest test/unit/product_chat/test_product_models.py test/integration/product_chat/test_product_schema.py -v
```

Expected: FAIL，原因是 `models_product` 或 `ensure_product_schema` 尚不存在。

- [ ] **Step 3: 定义数据库模型和稳定枚举**

`models_product.py` 使用 `models_business.Base`，字段固定为：

```python
from enum import Enum

class ConversationStatus(str, Enum):
    ACTIVE = "ACTIVE"
    ARCHIVED = "ARCHIVED"

class MessageRole(str, Enum):
    USER = "USER"
    ASSISTANT = "ASSISTANT"

class AnswerStatus(str, Enum):
    SUPPORTED = "SUPPORTED"
    INSUFFICIENT = "INSUFFICIENT"
    CONFLICTING = "CONFLICTING"

class CitationKind(str, Enum):
    ENTERPRISE_EVIDENCE = "ENTERPRISE_EVIDENCE"
```

创建以下字段；时间均使用 `utc_now_naive`，外部可见 ID 使用 26 位 ULID 字符串：

```text
feishu_user_bindings:
  id, user_id(FK users.id, UNIQUE), feishu_open_id(UNIQUE),
  feishu_user_id(UNIQUE, nullable), feishu_union_id(nullable), tenant_key,
  display_name, avatar_url, authorization_status(ACTIVE|REVOKED),
  last_login_at, created_at, updated_at

product_conversations:
  id, conversation_id(UNIQUE), owner_user_id(FK users.id), title,
  status(ACTIVE|ARCHIVED), created_at, updated_at
  INDEX(owner_user_id, status, updated_at)

product_messages:
  id, message_id(UNIQUE), conversation_id(FK product_conversations.conversation_id),
  role(USER|ASSISTANT), content, answer_status(nullable),
  model_version(nullable), prompt_version(nullable), created_at
  INDEX(conversation_id, created_at)

message_citations:
  id, citation_id(UNIQUE), message_id(FK product_messages.message_id),
  kind(ENTERPRISE_EVIDENCE), source_id, item_id, version_id, yuxi_file_id,
  title, source_url, path_text, locator, excerpt, source_version_at, created_at
  INDEX(message_id), INDEX(version_id)
```

数据库约束要求：用户消息的 `answer_status/model_version/prompt_version` 都为空；助手消息必须有 `answer_status`；引用必须关联助手消息，业务层再次校验。

- [ ] **Step 4: 增加幂等建表和旧库补列入口**

在 `manager.py` 顶部显式导入 `yuxi.storage.postgres.models_product`，确保 `BusinessBase.metadata.create_all` 能看到新表；增加：

```python
async def ensure_product_schema(self):
    self._check_initialized()
    statements = (
        "CREATE INDEX IF NOT EXISTS ix_product_conversations_owner_status_updated "
        "ON product_conversations (owner_user_id, status, updated_at)",
        "CREATE INDEX IF NOT EXISTS ix_product_messages_conversation_created "
        "ON product_messages (conversation_id, created_at)",
        "CREATE INDEX IF NOT EXISTS ix_message_citations_message_id "
        "ON message_citations (message_id)",
        "CREATE INDEX IF NOT EXISTS ix_message_citations_version_id "
        "ON message_citations (version_id)",
    )
    async with self.async_engine.begin() as conn:
        for statement in statements:
            await conn.execute(text(statement))
```

在应用 lifespan 的现有 PostgreSQL 初始化序列中，紧接 `create_tables()` 调用 `ensure_product_schema()`。本项目没有 Alembic，不在此计划中引入第二套迁移机制。

- [ ] **Step 5: 定义跨前后端一致的产品 DTO**

`schemas.py` 至少定义以下 Pydantic 模型，并用 `extra="forbid"` 禁止请求夹带技术参数：

```python
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field

def to_camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.capitalize() for part in tail)

class StrictRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

class ProductResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, serialize_by_alias=True)

class CreateConversationRequest(StrictRequest):
    title: str | None = Field(default=None, max_length=80)

class SendMessageRequest(StrictRequest):
    content: str = Field(min_length=1, max_length=20_000)

class ProductUserResponse(ProductResponse):
    id: str
    name: str
    avatar_url: str | None = None

class SessionResponse(ProductResponse):
    user: ProductUserResponse

class ConversationSummaryResponse(ProductResponse):
    id: str
    title: str
    status: Literal["ACTIVE", "ARCHIVED"]
    message_count: int
    created_at: str
    updated_at: str

class CitationResponse(ProductResponse):
    id: str
    kind: Literal["ENTERPRISE_EVIDENCE"]
    title: str
    path: str | None
    locator: str
    excerpt: str
    version_at: str | None

class MessageResponse(ProductResponse):
    id: str
    role: Literal["USER", "ASSISTANT"]
    content: str
    answer_status: Literal["SUPPORTED", "INSUFFICIENT", "CONFLICTING"] | None
    citations: list[CitationResponse]
    created_at: str

class ConversationListResponse(ProductResponse):
    conversations: list[ConversationSummaryResponse]

class ConversationResponse(ProductResponse):
    conversation: ConversationSummaryResponse

class ConversationDetailResponse(ConversationResponse):
    messages: list[MessageResponse]

class MessageExchangeResponse(ConversationResponse):
    user_message: MessageResponse
    assistant_message: MessageResponse
```

所有产品 API JSON 统一使用 camelCase（例如 `answerStatus`、`avatarUrl`、`createdAt`、`versionAt`），Python 内部保持 snake_case；React 不做临时字段转换。

- [ ] **Step 6: 运行测试确认通过**

Run: `uv run pytest test/unit/product_chat/test_product_models.py test/integration/product_chat/test_product_schema.py -v`

Expected: PASS；集成测试报告四张表存在，第二次 schema 初始化无异常。

- [ ] **Step 7: 提交后端数据骨架**

```bash
git add backend/package/yuxi/storage/postgres/models_product.py \
  backend/package/yuxi/storage/postgres/manager.py \
  backend/package/yuxi/product_chat/__init__.py \
  backend/package/yuxi/product_chat/schemas.py \
  backend/test/unit/product_chat/test_product_models.py \
  backend/test/integration/product_chat/test_product_schema.py
git commit -m "feat: persist enterprise assistant conversations"
```

### Task 2: 实现飞书 OAuth、一次性会话和默认拒绝的身份绑定

**Files:**
- Create: `backend/package/yuxi/product_chat/auth_service.py`
- Create: `backend/server/routers/product_auth_router.py`
- Modify: `backend/server/utils/auth_middleware.py`
- Modify: `backend/server/routers/__init__.py`
- Modify: `backend/test/unit/server/test_cors_config.py`
- Create: `backend/test/unit/product_chat/test_product_auth_service.py`
- Create: `backend/test/integration/product_chat/test_product_auth_api.py`

- [ ] **Step 1: 写 OAuth 安全边界失败测试**

覆盖以下可观察行为：

```python
@pytest.mark.parametrize("case", ["missing", "expired", "reused", "mismatched"])
async def test_callback_rejects_invalid_state(case, auth_client):
    response = await auth_client.callback(case=case)
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "FEISHU_OAUTH_STATE_INVALID"

async def test_callback_refuses_unknown_identity(auth_client):
    response = await auth_client.callback(case="valid_unmapped_user")
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "IDENTITY_MAPPING_REQUIRED"

async def test_cookie_auth_never_accepts_bearer_only_on_product_session(product_client):
    response = await product_client.get("/api/session", headers={"Authorization": "Bearer admin-token"})
    assert response.status_code == 401
```

另测：授权 URL 不含 App Secret；回调日志不含 `code`、user access token、Cookie；成功 Cookie 为 HttpOnly、SameSite=Lax，生产环境带 Secure；`POST /api/auth/logout` 清除 Cookie。`return_path` 只允许精确值 `/chat`，外部 URL、协议相对 URL 和其他站内路径一律归一化为 `/chat`，避免开放重定向。
在 CORS 测试中设置显式 React origin，断言 `allow_credentials=True` 且 `allow_origins` 不含 `*`；生产环境未配置 origin 时保持默认拒绝。

- [ ] **Step 2: 运行测试确认失败**

Run: `uv run pytest test/unit/product_chat/test_product_auth_service.py test/unit/server/test_cors_config.py test/integration/product_chat/test_product_auth_api.py -v`

Expected: FAIL，产品认证服务与路由尚不存在。

- [ ] **Step 3: 实现一次性 OAuth state 与飞书用户信息获取**

使用 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_PRODUCT_REDIRECT_URI`；服务接口固定为：

```python
COOKIE_NAME = "enterprise_assistant_session"
STATE_TTL_SECONDS = 300
SESSION_TTL_SECONDS = 8 * 60 * 60

class ProductAuthService:
    async def create_login_url(self, return_path: str = "/chat") -> str:
        """生成 32 字节随机 state，只把 state 哈希、return_path 和到期时间写入 Redis。"""

    async def complete_callback(self, code: str, state: str) -> tuple[User, str]:
        """原子读取并删除 state，交换 user_access_token，取用户信息，解析本地绑定并签发会话 JWT。"""

    async def resolve_bound_user(self, profile: dict) -> User:
        """先按 open_id 找绑定；首次绑定只接受 User.uid == 飞书 user_id 且已有 department_id 的用户。"""
```

会话 token 使用现有签名和 audience，只增加产品专用 claim，避免另造一套密钥：

```python
session_token = AuthUtils.create_access_token(
    {"sub": str(user.id), "token_kind": "enterprise_assistant"},
    expires_delta=timedelta(seconds=SESSION_TTL_SECONDS),
)
```

首次绑定不存在匹配用户、用户被删除、用户没有部门、绑定已撤销或租户不一致时返回 `IDENTITY_MAPPING_REQUIRED`，不得自动创建带默认部门的用户。这样不会因为猜测部门而扩大知识权限。

OAuth 网络调用使用以下边界，响应解析只保留身份字段，access token 不落库：

```text
Authorize: https://accounts.feishu.cn/open-apis/authen/v1/authorize
Token:     POST https://open.feishu.cn/open-apis/authen/v2/oauth/token
Profile:   GET  https://open.feishu.cn/open-apis/authen/v1/user_info
```

- [ ] **Step 4: 增加产品 Cookie 认证依赖和路由**

在 `auth_middleware.py` 增加独立依赖，不改变现有 Bearer API 的行为：

```python
async def get_product_user(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> User:
    token = request.cookies.get("enterprise_assistant_session")
    if not token:
        raise HTTPException(status_code=401, detail={"code": "LOGIN_REQUIRED", "message": "请使用飞书登录"})
    try:
        payload = AuthUtils.verify_access_token(token)
    except ValueError as exc:
        raise HTTPException(
            status_code=401,
            detail={"code": "SESSION_INVALID", "message": "登录已失效"},
        ) from exc
    if payload.get("token_kind") != "enterprise_assistant":
        raise HTTPException(status_code=401, detail={"code": "SESSION_INVALID", "message": "登录已失效"})
    result = await db.execute(select(User).where(User.id == int(payload["sub"]), User.is_deleted == 0))
    user = result.scalar_one_or_none()
    if user is None or user.department_id is None:
        raise HTTPException(status_code=403, detail={"code": "IDENTITY_MAPPING_REQUIRED", "message": "账号尚未完成组织映射"})
    return user
```

产品认证路由固定为：

```text
GET  /api/auth/feishu/login?return_path=/chat -> 307 飞书授权页
GET  /api/auth/feishu/callback?code=...&state=... -> 设置 Cookie 后 303 /chat
POST /api/auth/logout                         -> 204 并清除 Cookie
GET  /api/session                             -> { user: { id, name, avatarUrl } }
```

路由注册到非 `LITE_MODE` 分支；OAuth 错误重定向 `/login?error=<稳定错误码>`，不把异常正文放入 URL。

- [ ] **Step 5: 运行认证测试确认通过**

Run: `uv run pytest test/unit/product_chat/test_product_auth_service.py test/unit/server/test_cors_config.py test/integration/product_chat/test_product_auth_api.py -v`

Expected: PASS；重复回调为 401，未知映射为 403，成功响应设置安全 Cookie。

- [ ] **Step 6: 提交飞书产品认证**

```bash
git add backend/package/yuxi/product_chat/auth_service.py \
  backend/server/routers/product_auth_router.py \
  backend/server/utils/auth_middleware.py backend/server/routers/__init__.py \
  backend/test/unit/server/test_cors_config.py \
  backend/test/unit/product_chat/test_product_auth_service.py \
  backend/test/integration/product_chat/test_product_auth_api.py
git commit -m "feat: authenticate enterprise assistant with feishu"
```

### Task 3: 计算正式知识白名单并在 Milvus 召回前过滤

**Files:**
- Create: `backend/package/yuxi/product_chat/source_policy_service.py`
- Modify: `backend/package/yuxi/repositories/feishu_knowledge_repository.py`
- Modify: `backend/package/yuxi/knowledge/manager.py`
- Modify: `backend/package/yuxi/knowledge/implementations/milvus.py`
- Create: `backend/test/unit/product_chat/test_source_policy_service.py`
- Modify: `backend/test/unit/knowledge/test_milvus_retrieval_config.py`
- Create: `backend/test/integration/product_chat/test_retrieval_acl.py`

- [ ] **Step 1: 写正式版本和 Milvus 白名单失败测试**

构造同一来源下的发布版本、旧版本、待审核版本、索引失败版本和来源失效版本，只允许当前正式版本：

```python
assert await service.resolve_scope(user) == ProductKnowledgeScope(
    source_id="source-1",
    kb_id="kb-1",
    allowed_file_ids=("file-current",),
)
```

Milvus 测试必须捕获 vector、keyword、hybrid 三条 `search` 调用并断言统一包含：

```python
'file_id in ["file-current"]'
```

再断言 `allowed_file_ids=[]` 时零次调用 Milvus，权限检查抛异常时零次调用模型。
增加一例 `role="superadmin"` 但不在目标库 user/department 策略内的用户，断言产品访问仍被拒绝；这保证管理角色不会绕过普通问答的来源策略。

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
uv run pytest test/unit/product_chat/test_source_policy_service.py \
  test/unit/knowledge/test_milvus_retrieval_config.py \
  test/integration/product_chat/test_retrieval_acl.py -v
```

Expected: FAIL，`allowed_file_ids` 尚未进入检索表达式。

- [ ] **Step 3: 增加正式文件查询和唯一产品源解析**

Repository 新增查询，条件必须同时成立：

```python
select(FeishuSourceItem, FeishuMaterialVersion).join(
    FeishuMaterialVersion,
    FeishuMaterialVersion.version_id == FeishuSourceItem.active_version_id,
).where(
    FeishuSourceItem.source_id == source_id,
    FeishuSourceItem.source_validity == "valid",
    FeishuMaterialVersion.processing_status == "published",
    FeishuMaterialVersion.review_status == "approved",
    FeishuMaterialVersion.published_at.is_not(None),
    FeishuMaterialVersion.yuxi_file_id.is_not(None),
)
```

`ProductSourcePolicyService.resolve_scope(user)` 的顺序固定为：

1. 读取 `PRODUCT_FEISHU_SOURCE_ID` 并找到 `enabled=True` 的 `FeishuSource`；变量缺失、来源不存在或停用时返回 `PRODUCT_SOURCE_UNAVAILABLE`。
2. 使用 `source.target_kb_id` 调用新增的 `knowledge_base.check_policy_accessible(user.to_dict(), kb_id)`；该方法只计算 `share_config` 的 global/department/user 策略，不应用 superadmin 或创建者旁路。异常或 False 都返回 `KNOWLEDGE_ACCESS_DENIED`。
3. 查询满足上述条件的当前版本，去重并排序 `yuxi_file_id`。
4. 返回不可由前端覆盖的 `ProductKnowledgeScope`。

```python
@dataclass(frozen=True)
class ProductKnowledgeScope:
    source_id: str
    kb_id: str
    allowed_file_ids: tuple[str, ...]
```

`KnowledgeBaseManager` 中新增严格策略入口，现有管理端 `check_accessible()` 保持不变：

```python
async def check_policy_accessible(self, user: dict, kb_id: str) -> bool:
    from yuxi.repositories.knowledge_base_repository import KnowledgeBaseRepository

    kb = await KnowledgeBaseRepository().get_by_kb_id(kb_id)
    if kb is None:
        return False
    config = self._normalize_share_config(kb.share_config)
    if config["access_level"] == "global":
        return True
    if config["access_level"] == "department":
        return str(user.get("department_id")) in {str(value) for value in config["department_ids"]}
    if config["access_level"] == "user":
        return str(user.get("uid") or "") in set(config["user_uids"])
    return False
```

- [ ] **Step 4: 给 Milvus 三种召回模式增加同一文件过滤器**

在 `milvus.py` 增加安全转义与组合函数：

```python
@staticmethod
def _quote_expr_string(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'

def _build_allowed_file_expr(self, allowed_file_ids: list[str] | tuple[str, ...] | None) -> str | None:
    if allowed_file_ids is None:
        return None
    if not allowed_file_ids:
        return "file_id in []"
    values = ", ".join(self._quote_expr_string(value) for value in sorted(set(allowed_file_ids)))
    return f"file_id in [{values}]"

@staticmethod
def _combine_expr(*expressions: str | None) -> str | None:
    present = [f"({value})" for value in expressions if value]
    return " and ".join(present) or None
```

`aquery()` 检测到显式空列表时立即 `return []`；否则把 `_build_file_name_expr()` 与 `_build_allowed_file_expr()` 组合成一个 `file_expr`，原样传给 vector `search`、keyword `search` 和 hybrid 的两个 `AnnSearchRequest`。不把图谱召回用于产品问答，因为现有图谱路径没有同等文件白名单保证。

- [ ] **Step 5: 运行权限与检索测试确认通过**

Run:

```bash
uv run pytest test/unit/product_chat/test_source_policy_service.py \
  test/unit/knowledge/test_milvus_retrieval_config.py \
  test/integration/product_chat/test_retrieval_acl.py -v
```

Expected: PASS；三个检索模式均在召回前过滤，空白名单和权限故障均默认拒绝。

- [ ] **Step 6: 提交检索权限边界**

```bash
git add backend/package/yuxi/product_chat/source_policy_service.py \
  backend/package/yuxi/repositories/feishu_knowledge_repository.py \
  backend/package/yuxi/knowledge/manager.py \
  backend/package/yuxi/knowledge/implementations/milvus.py \
  backend/test/unit/product_chat/test_source_policy_service.py \
  backend/test/unit/knowledge/test_milvus_retrieval_config.py \
  backend/test/integration/product_chat/test_retrieval_acl.py
git commit -m "feat: filter product retrieval by published knowledge"
```

### Task 4: 实现受证据约束的回答与三种结论状态

**Files:**
- Create: `backend/package/yuxi/product_chat/repository.py`
- Create: `backend/package/yuxi/product_chat/answer_service.py`
- Create: `backend/test/unit/product_chat/test_answer_service.py`
- Create: `backend/test/integration/product_chat/test_answer_transaction.py`

- [ ] **Step 1: 写回答状态和事务失败测试**

覆盖：有充分依据为 `SUPPORTED`；没有片段时不调用模型并精确返回“暂无足够可靠资料”；来源互相冲突时为 `CONFLICTING`；模型引用不存在的 evidence ID 时降级为 `INSUFFICIENT`；模型失败时整个消息交换不落库；成功重试只写一组用户/助手消息。失败问题由 React 草稿保留，不在数据库制造孤立用户消息。

```python
assert result.status == "INSUFFICIENT"
assert result.content == "暂无足够可靠资料"
assert result.citations == []
fake_model.call.assert_not_awaited()
```

- [ ] **Step 2: 运行测试确认失败**

Run: `uv run pytest test/unit/product_chat/test_answer_service.py test/integration/product_chat/test_answer_transaction.py -v`

Expected: FAIL，回答服务和产品 Repository 尚不存在。

- [ ] **Step 3: 实现产品 Repository 的归属校验和原子写入**

Repository 的公共接口固定为：

```python
class ProductChatRepository:
    async def list_conversations(self, owner_user_id: int) -> list[ProductConversation]:
        """只返回当前用户且未归档的会话，按 updated_at 倒序。"""

    async def create_conversation(self, owner_user_id: int, title: str) -> ProductConversation:
        """创建 ACTIVE 会话；标题为空时由首问前 30 个字符生成。"""

    async def require_conversation(self, conversation_id: str, owner_user_id: int) -> ProductConversation:
        """归属不匹配统一返回 404，避免枚举他人会话。"""

    async def append_exchange(
        self,
        conversation: ProductConversation,
        user_content: str,
        answer: "GroundedAnswer",
    ) -> tuple[ProductMessage, ProductMessage]:
        """在一次事务中写用户消息、助手消息和全部引用，并更新会话时间。"""
```

归档使用条件更新 `WHERE conversation_id=:id AND owner_user_id=:owner AND status='ACTIVE'`，受影响行数不是 1 时返回 404。

- [ ] **Step 4: 实现确定的检索和回答规则**

`AnswerService.answer()` 只走 Yuxi 知识库 manager 和模型适配器，不创建 Agent/Skill：

```python
PROMPT_VERSION = "enterprise-grounded-v1"
INSUFFICIENT_TEXT = "暂无足够可靠资料"

SYSTEM_PROMPT = """你是企业知识助手。只能依据 EVIDENCE 中的文字回答。
不得使用常识补充企业能力、参数、承诺或案例。
证据不足时 status 必须是 INSUFFICIENT，answer 必须是“暂无足够可靠资料”。
证据互相冲突且无法由版本时间消解时 status 必须是 CONFLICTING，并说明冲突条件。
返回严格 JSON：{"status":"SUPPORTED|INSUFFICIENT|CONFLICTING","answer":"中文答案","citation_ids":["E1"]}。
citation_ids 只能使用输入中的证据编号。"""

@dataclass(frozen=True)
class GroundedCitation:
    evidence_id: str
    source_id: str
    item_id: str
    version_id: str
    yuxi_file_id: str
    title: str
    source_url: str
    path_text: str | None
    locator: str
    excerpt: str
    source_version_at: datetime | None

@dataclass(frozen=True)
class GroundedAnswer:
    status: Literal["SUPPORTED", "INSUFFICIENT", "CONFLICTING"]
    content: str
    citations: tuple[GroundedCitation, ...]
    model_version: str
    prompt_version: str = PROMPT_VERSION
```

执行顺序：解析产品源和允许文件 → `knowledge_base.aquery(question, kb_id, search_mode="hybrid", allowed_file_ids=list(scope.allowed_file_ids), use_graph_retrieval=False)` → 将每段映射到当前 `FeishuMaterialVersion` → 删除无法再次确认正式状态的片段 → 空集合直接返回不足 → `select_model(kb.llm_model_spec).call()` → 严格 JSON 解析 → 校验 citation IDs 为输入子集。`SUPPORTED` 没有有效引用、回答为空或 JSON 不合法都降级为不足；日志只记会话 ID、状态、数量、耗时和错误码，不记问题、答案、片段或模型凭据。

- [ ] **Step 5: 运行回答与事务测试确认通过**

Run: `uv run pytest test/unit/product_chat/test_answer_service.py test/integration/product_chat/test_answer_transaction.py -v`

Expected: PASS；无依据不会调用模型，三种状态和引用集合稳定，数据库无半写入。

- [ ] **Step 6: 提交受约束回答服务**

```bash
git add backend/package/yuxi/product_chat/repository.py \
  backend/package/yuxi/product_chat/answer_service.py \
  backend/test/unit/product_chat/test_answer_service.py \
  backend/test/integration/product_chat/test_answer_transaction.py
git commit -m "feat: answer only from authorized enterprise evidence"
```

### Task 5: 发布产品会话、消息和引用 API

**Files:**
- Create: `backend/package/yuxi/product_chat/citation_service.py`
- Create: `backend/server/routers/product_chat_router.py`
- Create: `backend/server/routers/product_citation_router.py`
- Modify: `backend/server/routers/__init__.py`
- Create: `backend/test/integration/product_chat/test_product_chat_api.py`
- Create: `backend/test/integration/product_chat/test_product_citation_api.py`

- [ ] **Step 1: 写完整 API 契约失败测试**

期望路由：

```python
EXPECTED_PRODUCT_ROUTES = {
    ("GET", "/chat/conversations"),
    ("POST", "/chat/conversations"),
    ("GET", "/chat/conversations/{conversation_id}"),
    ("POST", "/chat/conversations/{conversation_id}/messages"),
    ("POST", "/chat/conversations/{conversation_id}/archive"),
    ("GET", "/citations/{citation_id}"),
    ("GET", "/citations/{citation_id}/open"),
}
```

另测匿名 401、跨用户会话与引用均为 404、归档会话不能发送、重复归档无副作用、请求夹带 `kb_id/model/agent/top_k/prompt` 为 422、权限变化后旧引用返回 403、来源失效后旧引用返回 410。

- [ ] **Step 2: 运行 API 测试确认失败**

Run: `uv run pytest test/integration/product_chat/test_product_chat_api.py test/integration/product_chat/test_product_citation_api.py -v`

Expected: FAIL，路由尚未注册。

- [ ] **Step 3: 实现会话与消息路由**

所有端点依赖 `get_product_user`。响应契约固定为：

```text
GET  /api/chat/conversations
  200 { conversations: ConversationSummary[] }

POST /api/chat/conversations
  201 { conversation: ConversationSummary }

GET  /api/chat/conversations/{id}
  200 { conversation: ConversationSummary, messages: MessageResponse[] }

POST /api/chat/conversations/{id}/messages
  201 { conversation: ConversationSummaryResponse, userMessage: MessageResponse,
        assistantMessage: MessageResponse }

POST /api/chat/conversations/{id}/archive
  204
```

消息路由先完成检索与回答，再调用 `append_exchange()` 以一次事务写入整组用户消息、助手消息和引用；任一步失败都不落半组记录。阶段 1 前端发送期间禁用按钮，因此不增加新的客户端幂等字段。知识服务异常返回 `503 KNOWLEDGE_SERVICE_UNAVAILABLE`，并使用中文 `message`；React 保留草稿供用户重试，响应和日志不暴露堆栈。

- [ ] **Step 4: 实现引用二次校验和打开飞书原文**

`CitationService.resolve(citation_id, user)` 必须依次检查：引用属于当前用户会话；当前产品源仍启用；知识库严格 `share_config` 策略仍允许该用户（使用 `check_policy_accessible`，管理员身份不旁路）；引用版本仍是 item 的 `active_version_id`；item 仍为 `valid`；版本仍为 `published + approved` 且 `yuxi_file_id` 相同。通过后：

```text
GET /api/citations/{id}      -> 引用标题、目录、定位、摘录和版本时间
GET /api/citations/{id}/open -> 307 到保存的飞书 source_url
```

权限无法确认返回 403，来源已撤回或版本失效返回 410；绝不回退到保存时的旧授权结果。

- [ ] **Step 5: 注册路由并统一错误 envelope**

产品路由只在非 `LITE_MODE` 注册。稳定错误体为：

```json
{
  "error": {
    "code": "KNOWLEDGE_SERVICE_UNAVAILABLE",
    "message": "知识服务暂时不可用，请稍后重试"
  }
}
```

不要修改现有 Yuxi 管理 API 的响应形状；只在产品 router 内用共享异常处理函数生成该结构。

- [ ] **Step 6: 运行 API 测试确认通过**

Run: `uv run pytest test/integration/product_chat/test_product_chat_api.py test/integration/product_chat/test_product_citation_api.py -v`

Expected: PASS；跨用户读取为 404，引用权限变化实时生效，技术参数被拒绝。

- [ ] **Step 7: 提交产品 API**

```bash
git add backend/package/yuxi/product_chat/citation_service.py \
  backend/server/routers/product_chat_router.py \
  backend/server/routers/product_citation_router.py backend/server/routers/__init__.py \
  backend/test/integration/product_chat/test_product_chat_api.py \
  backend/test/integration/product_chat/test_product_citation_api.py
git commit -m "feat: expose enterprise assistant product api"
```

### Task 6: 把 React 会话和路由切换到产品 API

**Files:**
- Create: `shared/api/product.ts`
- Modify: `src/api/client.ts`
- Modify: `src/api/client.test.ts`
- Modify: `src/session/SessionProvider.tsx`
- Create: `src/session/SessionProvider.test.tsx`
- Create: `src/pages/LoginPage.tsx`
- Create: `src/pages/LoginPage.test.tsx`
- Modify: `src/app/App.tsx`
- Modify: `src/app/App.test.tsx`

- [ ] **Step 1: 写 Cookie、登录守卫和无技术入口失败测试**

测试 `fetch` 始终带 `credentials: 'include'`；`/api/session` 401 时显示飞书登录页；登录按钮指向 `/api/auth/feishu/login?return_path=%2Fchat`；成功会话直达 `/chat`；DOM 中不存在 `Knowledge Factory`、Yuxi、模型、智能体、Skill、知识库选择、回答范围、演示身份和 `@` 操作。

```typescript
expect(fetchMock).toHaveBeenCalledWith('/api/session', expect.objectContaining({
  credentials: 'include',
}))
expect(screen.getByRole('link', { name: '使用飞书登录' })).toHaveAttribute(
  'href',
  '/api/auth/feishu/login?return_path=%2Fchat',
)
```

- [ ] **Step 2: 运行前端测试确认失败**

Run:

```bash
cd /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase
npm test -- src/api/client.test.ts src/session/SessionProvider.test.tsx src/pages/LoginPage.test.tsx src/app/App.test.tsx --run
```

Expected: FAIL，旧客户端不带 Cookie，旧壳层仍显示演示身份和 Factory。

- [ ] **Step 3: 定义产品 DTO 并切换 API 客户端**

先创建尚不存在的 `shared/api/` 目录，再由 `shared/api/product.ts` 定义且只导出：

```typescript
export type AnswerStatus = 'SUPPORTED' | 'INSUFFICIENT' | 'CONFLICTING'
export type ConversationStatus = 'ACTIVE' | 'ARCHIVED'

export interface ProductUser { id: string; name: string; avatarUrl: string | null }
export interface ProductConversation {
  id: string; title: string; status: ConversationStatus
  messageCount: number; createdAt: string; updatedAt: string
}
export interface ProductCitation {
  id: string; kind: 'ENTERPRISE_EVIDENCE'; title: string
  path: string | null; locator: string; excerpt: string; versionAt: string | null
}
export interface ProductMessage {
  id: string; role: 'USER' | 'ASSISTANT'; content: string
  answerStatus: AnswerStatus | null; citations: ProductCitation[]; createdAt: string
}
```

`api()` 固定为：

```typescript
const response = await fetch(path, {
  ...init,
  credentials: 'include',
  headers,
})
```

保持现有 `ApiError`，同时兼容 FastAPI 的 `body.error`；不再添加 Bearer token。

- [ ] **Step 4: 重写 SessionProvider 和普通用户路由**

Session context 只保留：

```typescript
interface SessionContextValue {
  user?: ProductUser
  status: 'loading' | 'authenticated' | 'anonymous' | 'error'
  error?: Error
  reload: () => Promise<void>
  logout: () => Promise<void>
}
```

删除 `users`、`role` 和 `switchRole`。`App.tsx` 只公开 `/login`、`/chat` 和兜底路由；`authenticated` 访问 `/login` 转 `/chat`，`anonymous` 访问 `/chat` 转 `/login`。保留旧 Factory 页面文件但不再导入或注册，避免本任务顺带删除无关代码。

- [ ] **Step 5: 运行会话与路由测试确认通过**

Run: `npm test -- src/api/client.test.ts src/session/SessionProvider.test.tsx src/pages/LoginPage.test.tsx src/app/App.test.tsx --run`

Expected: PASS；未登录只有飞书登录入口，登录后只进入企业知识助手。

- [ ] **Step 6: 提交 React 认证与路由**

```bash
git add shared/api/product.ts src/api/client.ts src/api/client.test.ts \
  src/session/SessionProvider.tsx src/session/SessionProvider.test.tsx \
  src/pages/LoginPage.tsx src/pages/LoginPage.test.tsx \
  src/app/App.tsx src/app/App.test.tsx
git commit -m "feat: route product users through feishu login"
```

### Task 7: 完成独立问答工作台、固定输入框和来源抽屉

**Files:**
- Modify: `src/components/layout/ProductShell.tsx`
- Modify: `src/pages/ChatPage.tsx`
- Modify: `src/pages/ChatPage.test.tsx`
- Modify: `src/components/chat/ChatComposer.tsx`
- Create: `src/components/chat/ChatComposer.test.tsx`
- Modify: `src/components/chat/MessageThread.tsx`
- Modify: `src/components/chat/MessageThread.test.tsx`
- Modify: `src/components/chat/SourceDrawer.tsx`
- Modify: `src/components/chat/SourceDrawer.test.tsx`
- Modify: `src/styles/app.css`

- [ ] **Step 1: 写普通用户关键流程和布局失败测试**

覆盖新建、切换、归档、发送、失败保留草稿、三种回答提示、引用抽屉开关和移动端可访问性；同时断言阶段 1 不渲染上传按钮或范围选择：

```typescript
expect(screen.queryByRole('button', { name: '上传资料' })).not.toBeInTheDocument()
expect(screen.queryByLabelText('回答范围')).not.toBeInTheDocument()
expect(screen.getByRole('textbox', { name: '问题' })).toBeVisible()
expect(screen.getByText('暂无足够可靠资料')).toBeInTheDocument()
```

CSS 契约测试读取 `app.css`，确认 `.chat-main` 为三行网格、`.chat-message-scroll` 是唯一纵向滚动区、`.chat-composer-dock` 不使用 `position: fixed`。

- [ ] **Step 2: 运行问答组件测试确认失败**

Run:

```bash
npm test -- src/pages/ChatPage.test.tsx src/components/chat/ChatComposer.test.tsx \
  src/components/chat/MessageThread.test.tsx src/components/chat/SourceDrawer.test.tsx --run
```

Expected: FAIL，旧页面仍发送 scope/附件并链接 Factory 资料页。

- [ ] **Step 3: 精简壳层和输入区**

`ProductShell` 顶部只显示“企业知识助手”、当前用户头像/姓名和退出按钮。`ChatComposer` props 改为：

```typescript
interface ChatComposerProps {
  value: string
  disabled?: boolean
  onChange: (value: string) => void
  onSubmit: () => void
}
```

组件只渲染问题 textarea 与 lucide `Send` 按钮；Enter 发送、Shift+Enter 换行；发送中按钮禁用且 textarea 保持当前文字，服务器成功后才清空。

- [ ] **Step 4: 用产品 API 重写 ChatPage 状态流**

请求只能是：

```typescript
await api('/api/chat/conversations', { method: 'POST', body: JSON.stringify({}) })
await api(`/api/chat/conversations/${conversationId}/messages`, {
  method: 'POST',
  body: JSON.stringify({ content: draft.trim() }),
})
await api(`/api/chat/conversations/${conversationId}/archive`, { method: 'POST' })
```

发送期间禁用新建、切换、归档和再次发送；切换会话使用递增 context version 丢弃迟到响应。首次提问若还没有会话，先创建再发送。接口失败保留草稿和当前消息，显示稳定中文错误与重试入口。

- [ ] **Step 5: 展示状态和二次授权引用**

助手消息标签映射固定为：

```typescript
const answerStatusLabel = {
  SUPPORTED: '有正式资料支持',
  INSUFFICIENT: '依据不足',
  CONFLICTING: '资料存在冲突',
} as const
```

引用按钮显示 `[1]`，点击后用 citation ID 请求 `/api/citations/{id}` 再打开右侧抽屉；“打开飞书原文”链接指向 `/api/citations/{id}/open`，不链接 `/factory/assets/*`。桌面端抽屉为右栏，窄屏为全宽覆盖层，关闭后焦点回到原引用按钮。

- [ ] **Step 6: 固定输入区并保持浅蓝、透明分隔**

核心 CSS 必须保持如下布局，不用 viewport 字号缩放：

```css
.chat-page { height: 100%; min-height: 0; }
.chat-layout { height: 100%; min-height: 0; display: grid; grid-template-columns: 220px minmax(0, 1fr); }
.chat-layout.source-open { grid-template-columns: 220px minmax(0, 1fr) 320px; }
.chat-main { min-height: 0; display: grid; grid-template-rows: 56px minmax(0, 1fr) auto; background: #fff; }
.chat-message-scroll { min-height: 0; overflow-y: auto; overflow-x: hidden; }
.chat-composer-dock { position: static; padding: 12px 24px 18px; background: #fff; }
.conversation-sidebar, .source-drawer { border-color: transparent; background: #f4f8fd; }
```

保留浅蓝主色和 8px 以内圆角；不增加渐变、装饰球或卡片嵌套。

- [ ] **Step 7: 运行组件、类型和构建测试确认通过**

Run:

```bash
npm test -- src/pages/ChatPage.test.tsx src/components/chat/ChatComposer.test.tsx \
  src/components/chat/MessageThread.test.tsx src/components/chat/SourceDrawer.test.tsx --run
npm run typecheck
npm run build
```

Expected: 全部 PASS；`dist/` 构建成功，测试 DOM 不含技术入口、上传或范围选择。

- [ ] **Step 8: 提交独立问答界面**

```bash
git add src/components/layout/ProductShell.tsx src/pages/ChatPage.tsx src/pages/ChatPage.test.tsx \
  src/components/chat/ChatComposer.tsx src/components/chat/ChatComposer.test.tsx \
  src/components/chat/MessageThread.tsx src/components/chat/MessageThread.test.tsx \
  src/components/chat/SourceDrawer.tsx src/components/chat/SourceDrawer.test.tsx src/styles/app.css
git commit -m "feat: deliver standalone enterprise knowledge chat"
```

### Task 8: 配置联调入口并完成自动化、浏览器和真实飞书验收

**Files:**
- Modify: `vite.config.ts`
- Modify: `.env.example`
- Create: `backend/test/unit/deployment/test_enterprise_assistant_config.py`
- Create: `backend/test/e2e/product_chat/test_enterprise_answer_flow.py`
- Create: `docs/implementation/enterprise-assistant-operations.md`
- Modify: `docs/implementation/acceptance-log.md`

- [ ] **Step 1: 写部署契约和真实链路测试骨架**

部署契约测试要求以下变量有说明但无真实值：

```text
FEISHU_APP_ID
FEISHU_APP_SECRET
FEISHU_PRODUCT_REDIRECT_URI
PRODUCT_FEISHU_SOURCE_ID
YUXI_CORS_ORIGINS
```

`test_enterprise_assistant_config.py` 读取仓库根 `.env.example` 并检查上述变量名和空示例值。E2E 测试用 `RUN_REAL_PRODUCT_E2E=1` 才执行，读取预先绑定的测试用户 Cookie，不在 fixture 或日志打印 Cookie；用三个问题验证 `SUPPORTED`、`INSUFFICIENT` 和可打开引用。

- [ ] **Step 2: 运行部署契约测试确认失败**

Run:

```bash
cd /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase-Yuxi/.worktrees/feishu-tenant-token-auth/backend
uv run pytest test/unit/deployment/test_enterprise_assistant_config.py -v
uv run pytest test/e2e/product_chat/test_enterprise_answer_flow.py -v
```

Expected: 配置契约测试先 FAIL，指出缺少 `FEISHU_PRODUCT_REDIRECT_URI` 或 `PRODUCT_FEISHU_SOURCE_ID`；真实 E2E 在未设置开关时 SKIP 且可正常收集。

- [ ] **Step 3: 完成开发代理和运维说明**

把 React `vite.config.ts` 的 `/api` 代理改为当前 FastAPI `http://127.0.0.1:5050`。运维文档只包含：启动 PostgreSQL/Redis/MinIO/Milvus、启动 FastAPI、启动 worker、启动 React、配置飞书回调、设置 `PRODUCT_FEISHU_SOURCE_ID`、预绑定 `User.uid == 飞书 user_id` 与部门、验证健康检查和回滚到上一提交；不记录 App Secret、token、Cookie 或企业正文。

- [ ] **Step 4: 运行后端阶段 1 回归**

Run:

```bash
cd /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase-Yuxi/.worktrees/feishu-tenant-token-auth/backend
uv run pytest test/unit/product_chat test/integration/product_chat -v
uv run pytest test/unit/knowledge/test_milvus_retrieval_config.py \
  test/unit/integrations/test_feishu_client.py \
  test/unit/deployment/test_enterprise_assistant_config.py \
  test/integration/api/test_feishu_knowledge_api_integration.py -v
uv run ruff check package/yuxi/product_chat server/routers/product_* test/unit/product_chat test/integration/product_chat
```

Expected: 全部 PASS，Ruff 无错误。

- [ ] **Step 5: 运行前端全量回归**

Run:

```bash
cd /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase
npm run test:run
npm run typecheck
npm run build
```

Expected: 全部 PASS，Vite 生产构建成功。

- [ ] **Step 6: 启动服务并做浏览器验收**

按 `browse` 技能在 1440×900、1024×768、390×844 三个视口验证：飞书登录后直接进入“企业知识助手”；左侧会话、中间消息、右侧按需来源；长回答只滚动消息区；输入框始终在底部；移动端无横向溢出或遮挡；控制台无新增错误；页面不存在 Yuxi、模型、Agent、Skill、知识库选择、范围选择和 `@`。

Expected: 三个视口全部通过，并把脱敏截图放到 gitignored `artifacts/acceptance/enterprise-assistant-phase-1/`。

- [ ] **Step 7: 执行真实飞书链路验收并更新记录**

Run:

```bash
cd /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase-Yuxi/.worktrees/feishu-tenant-token-auth/backend
RUN_REAL_PRODUCT_E2E=1 uv run pytest test/e2e/product_chat/test_enterprise_answer_flow.py -m e2e -v
```

Expected: 一个正式知识问题为 `SUPPORTED` 且能回到飞书原文；一个未知问题精确返回“暂无足够可靠资料”；一个无权限测试用户既不能召回也不能打开来源。只把日期、场景、状态和脱敏引用 ID 写入 `docs/implementation/acceptance-log.md`。

- [ ] **Step 8: 提交部署与验收材料**

先用 `git diff -- docs/implementation/acceptance-log.md` 核对并保留该文件执行前已有内容，只追加本阶段记录：

```bash
git add .env.example backend/test/unit/deployment/test_enterprise_assistant_config.py \
  backend/test/e2e/product_chat/test_enterprise_answer_flow.py \
  docs/implementation/enterprise-assistant-operations.md docs/implementation/acceptance-log.md
git commit -m "test: verify enterprise assistant phase one"
```

在 React 仓库提交代理配置，明确排除 `.superpowers/` 和 `artifacts/`：

```bash
cd /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase
git add vite.config.ts
git commit -m "chore: connect assistant ui to fastapi"
```

## 阶段 1 完成标准

- 飞书 OAuth 成功、拒绝、过期、重复 state 和身份映射失败均有自动测试。
- 普通用户只能读取自己的会话和引用；权限不确定时默认拒绝。
- 前端请求不含 `kb_id`、模型、Agent、Skill、Top-K、提示词、范围或 `@`。
- 服务器只解析 `PRODUCT_FEISHU_SOURCE_ID` 对应的目标库，只召回当前有效、已审核、已发布且有 `yuxi_file_id` 的版本。
- `SUPPORTED`、`INSUFFICIENT`、`CONFLICTING` 三种状态可持久化并正确显示；无依据精确回答“暂无足够可靠资料”。
- 引用打开前重新校验当前权限和来源状态，可跳转到原始飞书页面。
- 输入框在对话区底部不动，只有消息区滚动；桌面、平板和手机无溢出、遮挡或新增控制台错误。
- 后端测试、前端测试、类型检查、Ruff、生产构建、浏览器验收和真实飞书验收全部通过。
- 阶段 1 可单独部署，完全不依赖阶段 2 的附件能力。
