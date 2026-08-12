# Yuxi 基线隔离部署 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在同级独立目录部署并验收固定版 Yuxi `v0.7.1`，证明外部模型、普通文档解析、Milvus 检索、带来源回答和持久化重启在本机可用。

**Architecture:** 上游 Yuxi 保存在 `/Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase-Yuxi`，使用独立 Compose project `quickdone-kb-yuxi` 和项目内数据卷目录。此阶段只做基线固定、最小 Compose 启动、凭据保护和能力验收，不增加飞书或治理业务代码。

**Tech Stack:** Git、Docker Compose、Yuxi `v0.7.1`、FastAPI、Vue、PostgreSQL、Redis/ARQ、MinIO、Milvus/etcd、RapidOCR、外部 OpenAI-compatible Chat/Embedding API、pytest。

---

## 文件结构

本阶段在新 Yuxi 工程中只创建以下定制文件：

```text
KnowledgeBase-Yuxi/
├── .env                         # 本机秘密，不提交
├── .env.example                 # 仅变量名和安全默认值
├── compose.phase1.yml           # 第一阶段服务与资源覆盖
├── docs/implementation/
│   ├── acceptance-log.md        # 脱敏验收记录
│   └── decision-log.md          # 基线偏差记录
├── scripts/phase1_smoke.py      # 无秘密的健康/持久化检查
└── backend/test/unit/deployment/
    └── test_phase1_contract.py  # Compose 和秘密保护契约
```

不得修改当前 `KnowledgeBase` 的业务源码。

### Task 1: 安全创建固定版 Yuxi 工作区

**Files:**
- Create directory: `/Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase-Yuxi`
- Verify: `/Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase-Yuxi/.git`

- [ ] **Step 1: 验证精确路径和磁盘条件**

Run:

```bash
test "$(pwd)" = "/Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase"
test ! -e /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase-Yuxi
docker version --format '{{.Server.Version}}'
docker compose version
df -h /Users/apple/Documents/Codex/projects/Quickdone
```

Expected: 目标目录不存在；Docker daemon 可访问；磁盘有至少 30 GiB 可用空间。任一条件失败立即停止，不覆盖同名目录。

- [ ] **Step 2: 克隆固定 tag**

Run:

```bash
git clone --branch v0.7.1 --single-branch https://github.com/xerrors/Yuxi.git /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase-Yuxi
cd /Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase-Yuxi
git rev-parse HEAD
```

Expected: 输出必须为 `dfb3aa203ab3d6390465d99f718e5d7fce50eecb`。若 tag 不存在或 SHA 不一致，停止并在决策记录中报告，不改用 `main`。

- [ ] **Step 3: 建立集成分支并保留上游**

Run:

```bash
git switch -c integration/quickdone-feishu-v1
git remote rename origin upstream
git remote -v
```

Expected: 当前分支为 `integration/quickdone-feishu-v1`，`upstream` 指向 `https://github.com/xerrors/Yuxi.git`。

- [ ] **Step 4: 写入脱敏记录骨架**

Create `docs/implementation/acceptance-log.md`:

```markdown
# 实施验收记录

## 基线

- 日期：2026-08-12
- Yuxi：v0.7.1 / dfb3aa203ab3d6390465d99f718e5d7fce50eecb
- Compose project：quickdone-kb-yuxi
- 凭据：仅记录配置状态，不记录值

## 阶段结论

| 阶段 | 结果 | 证据摘要 | 操作者 |
| --- | --- | --- | --- |
| 1 | RUNNING | 尚未完成 | Codex + 用户 |
```

Create `docs/implementation/decision-log.md`:

```markdown
# 实施决策记录

| 日期 | 决策 | 原因 | 影响 |
| --- | --- | --- | --- |
| 2026-08-12 | 固定 Yuxi v0.7.1 | 保持可重现基线 | 上游更新只选择性合并 |
```

- [ ] **Step 5: 提交固定基线记录**

```bash
git add docs/implementation
git commit -m "docs: record pinned yuxi baseline"
```

Expected: 提交不包含 `.env` 或运行数据。

### Task 2: 用测试锁定第一阶段 Compose 契约

**Files:**
- Create: `backend/test/unit/deployment/test_phase1_contract.py`
- Create: `compose.phase1.yml`
- Modify: `.gitignore`
- Create: `.env.example`

- [ ] **Step 1: 写失败测试**

Create `backend/test/unit/deployment/test_phase1_contract.py`:

```python
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[4]


def test_phase1_compose_uses_isolated_project_and_required_services():
    config = yaml.safe_load((ROOT / "compose.phase1.yml").read_text())
    assert config["name"] == "quickdone-kb-yuxi"
    assert {
        "api", "worker", "web", "postgres", "redis", "minio", "etcd", "milvus", "sandbox-provisioner"
    } <= set(config["services"])
    assert "graph" not in config["services"]
    assert config["services"]["api"]["environment"]["YUXI_ENV"] == "development"


def test_secrets_and_runtime_volumes_are_ignored():
    ignored = (ROOT / ".gitignore").read_text().splitlines()
    for entry in (".env", "docker/volumes/", "artifacts/acceptance/"):
        assert entry in ignored


def test_env_example_contains_names_but_no_secret_values():
    text = (ROOT / ".env.example").read_text()
    for name in (
        "OPENAI_API_KEY", "OPENAI_API_BASE", "JWT_SECRET_KEY", "POSTGRES_PASSWORD",
        "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY", "SANDBOX_PROVISIONER_TOKEN",
    ):
        assert f"{name}=" in text
    assert "sk-" not in text
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd backend
uv run pytest test/unit/deployment/test_phase1_contract.py -v
```

Expected: FAIL，原因是 `compose.phase1.yml` 或 `.env.example` 不存在。

- [ ] **Step 3: 写最小 Compose 覆盖和安全模板**

Create `compose.phase1.yml`:

```yaml
name: quickdone-kb-yuxi
services:
  api:
    extends: {file: docker-compose.yml, service: api}
    container_name: quickdone-kb-api
    environment: {YUXI_ENV: development, LITE_MODE: "false"}
  worker:
    extends: {file: docker-compose.yml, service: worker}
    container_name: quickdone-kb-worker
  web:
    extends: {file: docker-compose.yml, service: web}
    container_name: quickdone-kb-admin-web
  postgres:
    extends: {file: docker-compose.yml, service: postgres}
    container_name: quickdone-kb-postgres
  redis:
    extends: {file: docker-compose.yml, service: redis}
    container_name: quickdone-kb-redis
  minio:
    extends: {file: docker-compose.yml, service: minio}
    container_name: quickdone-kb-minio
  etcd:
    extends: {file: docker-compose.yml, service: etcd}
    container_name: quickdone-kb-etcd
  milvus:
    extends: {file: docker-compose.yml, service: milvus}
    container_name: quickdone-kb-milvus
  sandbox-provisioner:
    extends: {file: docker-compose.yml, service: sandbox-provisioner}
    container_name: quickdone-kb-sandbox-provisioner
networks:
  app-network:
    name: quickdone-kb-yuxi-network
volumes:
  nltk_data:
```

Append to `.gitignore`:

```gitignore
.env
docker/volumes/
artifacts/acceptance/
```

Create `.env.example`:

```dotenv
YUXI_ENV=development
YUXI_INSTANCE_ID=
YUXI_CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
OPENAI_API_KEY=
OPENAI_API_BASE=
JWT_SECRET_KEY=
POSTGRES_USER=postgres
POSTGRES_PASSWORD=
POSTGRES_DB=yuxi
MINIO_ACCESS_KEY=
MINIO_SECRET_KEY=
SANDBOX_PROVISIONER_TOKEN=
LITE_MODE=false
```

- [ ] **Step 4: 运行契约测试和 Compose 解析**

Run:

```bash
cd backend
uv run pytest test/unit/deployment/test_phase1_contract.py -v
cd ..
docker compose -f compose.phase1.yml --env-file .env.example config --services
```

Expected: 3 tests PASS；服务列表包含九个期望服务且不包含 `graph`、`mineru-api` 或 `paddlex`。

- [ ] **Step 5: 提交部署契约**

```bash
git add .gitignore .env.example compose.phase1.yml backend/test/unit/deployment/test_phase1_contract.py
git commit -m "chore: define isolated phase one deployment"
```

### Task 3: 安全配置本机环境并启动服务

**Files:**
- Create: `.env`（不提交）
- Verify: `docker/volumes/`

- [ ] **Step 1: 从模板创建私有配置并生成本机秘密**

Run from Yuxi root:

```bash
cp .env.example .env
python3 - <<'PY'
from pathlib import Path
import secrets

path = Path('.env')
values = {
    'YUXI_INSTANCE_ID': f'quickdone-{secrets.token_hex(8)}',
    'JWT_SECRET_KEY': secrets.token_hex(32),
    'POSTGRES_PASSWORD': secrets.token_urlsafe(32),
    'MINIO_ACCESS_KEY': secrets.token_hex(12),
    'MINIO_SECRET_KEY': secrets.token_urlsafe(32),
    'SANDBOX_PROVISIONER_TOKEN': secrets.token_hex(32),
}
lines = []
for line in path.read_text().splitlines():
    key = line.partition('=')[0]
    lines.append(f'{key}={values[key]}' if key in values else line)
path.write_text('\n'.join(lines) + '\n')
PY
```

Expected: `.env` 存在，生成项非空；终端没有打印任何秘密值。

- [ ] **Step 2: 由用户在本机录入模型连接**

Run:

```bash
read -r -p "OpenAI-compatible API Base: " MODEL_API_BASE
read -r -s -p "OpenAI-compatible API Key: " MODEL_API_KEY
echo
MODEL_API_BASE="$MODEL_API_BASE" MODEL_API_KEY="$MODEL_API_KEY" python3 - <<'PY'
from pathlib import Path
import os

path = Path('.env')
updates = {'OPENAI_API_BASE': os.environ['MODEL_API_BASE'], 'OPENAI_API_KEY': os.environ['MODEL_API_KEY']}
lines = []
for line in path.read_text().splitlines():
    key = line.partition('=')[0]
    lines.append(f'{key}={updates[key]}' if key in updates else line)
path.write_text('\n'.join(lines) + '\n')
PY
unset MODEL_API_BASE MODEL_API_KEY
```

Expected: 用户的真实值只进入 `.env`，不出现在 shell 输出或 Git diff。模型 ID 不在此处猜测；启动后从供应商真实 `/models` 响应选择同时支持中文长上下文/结构化输出的 Chat 模型和中英文 Embedding 模型，并把选择写入脱敏决策记录。

- [ ] **Step 3: 验证秘密未被 Git 跟踪**

Run:

```bash
git check-ignore -v .env docker/volumes artifacts/acceptance
git diff -- .env
git status --short
```

Expected: `.env` 和运行目录均命中 `.gitignore`；`git diff -- .env` 无输出。

- [ ] **Step 4: 构建并启动明确服务集合**

Run:

```bash
docker compose -f compose.phase1.yml --env-file .env up -d --build \
  postgres redis minio etcd milvus sandbox-provisioner api worker web
docker compose -f compose.phase1.yml --env-file .env ps
```

Expected: 九个服务均为 `Up`；有 healthcheck 的服务最终为 `healthy`。不要运行 `make reset`。

- [ ] **Step 5: 验证健康接口和技术管理界面**

Run:

```bash
curl --fail --silent http://127.0.0.1:5050/api/system/health
curl --fail --silent --output /dev/null http://127.0.0.1:5173/
docker compose -f compose.phase1.yml --env-file .env logs --tail=100 api worker
```

Expected: 健康接口返回成功 JSON；Vue 页面返回 2xx；日志无数据库、Milvus、MinIO 或 Redis 持续连接失败。

### Task 4: 编写可重复的持久化 smoke 检查

**Files:**
- Create: `scripts/phase1_smoke.py`
- Test: `backend/test/unit/deployment/test_phase1_smoke.py`

- [ ] **Step 1: 写失败测试**

Create `backend/test/unit/deployment/test_phase1_smoke.py`:

```python
import importlib.util
from pathlib import Path


def test_smoke_script_requires_health_and_persistence_marker():
    path = Path(__file__).resolve().parents[4] / "scripts" / "phase1_smoke.py"
    spec = importlib.util.spec_from_file_location("phase1_smoke", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.required_checks() == ("api_health", "postgres_marker", "minio_health", "milvus_health")
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && uv run pytest test/unit/deployment/test_phase1_smoke.py -v`

Expected: FAIL，原因是 `scripts/phase1_smoke.py` 不存在。

- [ ] **Step 3: 写最小 smoke 脚本**

Create `scripts/phase1_smoke.py`:

```python
import json
import subprocess
import urllib.request


def required_checks():
    return ("api_health", "postgres_marker", "minio_health", "milvus_health")


def fetch_json(url: str):
    with urllib.request.urlopen(url, timeout=10) as response:
        return json.loads(response.read())


def compose_exec(service: str, *args: str):
    return subprocess.run(
        ["docker", "compose", "-f", "compose.phase1.yml", "exec", "-T", service, *args],
        check=True, text=True, capture_output=True,
    ).stdout.strip()


def main():
    assert fetch_json("http://127.0.0.1:5050/api/system/health")
    marker = compose_exec("postgres", "psql", "-U", "postgres", "-d", "yuxi", "-Atc", "select value from phase1_smoke where id=1")
    assert marker == "survives-restart"
    assert urllib.request.urlopen("http://127.0.0.1:9000/minio/health/live", timeout=10).status == 200
    assert compose_exec("milvus", "curl", "--fail", "--silent", "http://127.0.0.1:9091/healthz")
    print("phase1 smoke: PASS")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: 运行单元测试确认通过**

Run: `cd backend && uv run pytest test/unit/deployment/test_phase1_smoke.py -v`

Expected: PASS。

- [ ] **Step 5: 创建持久化标记、重启并运行 smoke**

Run from Yuxi root:

```bash
docker compose -f compose.phase1.yml exec -T postgres psql -U postgres -d yuxi -c \
  "create table if not exists phase1_smoke(id integer primary key, value text not null); insert into phase1_smoke values (1, 'survives-restart') on conflict (id) do update set value=excluded.value;"
docker compose -f compose.phase1.yml restart postgres redis minio etcd milvus api worker
python3 scripts/phase1_smoke.py
```

Expected: 输出 `phase1 smoke: PASS`，证明数据库标记和服务数据在普通重启后仍存在。

- [ ] **Step 6: 提交 smoke 检查**

```bash
git add scripts/phase1_smoke.py backend/test/unit/deployment/test_phase1_smoke.py
git commit -m "test: add phase one persistence smoke check"
```

### Task 5: 完成人工基线能力验收

**Files:**
- Modify: `docs/implementation/acceptance-log.md`
- Store locally only: `artifacts/acceptance/phase1/`

- [ ] **Step 1: 配置并验证外部模型供应商**

在 `http://127.0.0.1:5173` 使用本地超级管理员登录，进入模型供应商配置；创建 `provider_type=openai` 的供应商，使用 `.env` 中的 Base URL/Key，调用远端模型列表并选择真实返回的 Chat 与 Embedding 模型。

Expected: 一次中文结构化测试返回合法 JSON；一次中英文 Embedding 测试返回非空且维度一致的向量。验收记录只写供应商名、模型 ID 和结果，不写 Key。

- [ ] **Step 2: 上传三种无敏感测试资料**

分别上传：UTF-8 TXT、含两页文字的 PDF、含清晰中文文字的 PNG。内容统一包含唯一标记 `QD-PHASE1-EVIDENCE-20260812`。

Expected: 三个文件均解析成功；PDF 有页码定位；PNG OCR 提取出唯一标记；解析产物可在技术界面预览。

- [ ] **Step 3: 验证 Milvus 检索和带引用回答**

询问“阶段一证据标记是什么，它来自哪些文件？”

Expected: 回答包含 `QD-PHASE1-EVIDENCE-20260812`，至少返回一个可打开的来源；不凭模型常识生成其他标记。

- [ ] **Step 4: 验证容器整体重启**

Run:

```bash
docker compose -f compose.phase1.yml --env-file .env down
docker compose -f compose.phase1.yml --env-file .env up -d \
  postgres redis minio etcd milvus sandbox-provisioner api worker web
python3 scripts/phase1_smoke.py
```

Expected: smoke PASS；此前上传文件、解析结果、模型配置和检索结果仍存在。

- [ ] **Step 5: 运行基线自动测试**

Run:

```bash
make test
make lint
cd backend && uv run pytest -m unit
cd ../web && pnpm run test:unit
pnpm run build
```

Expected: 所有命令退出码 0。若上游基线本身存在失败，记录精确测试名并停止阶段签署，不静默跳过。

- [ ] **Step 6: 签署阶段门禁并提交**

把登录、外部模型、TXT/PDF/PNG 解析、Milvus 检索、带来源回答和重启持久化逐项记为 PASS，删除本地验收截图中的敏感内容后再引用其文件名。

```bash
git add docs/implementation/acceptance-log.md docs/implementation/decision-log.md
git commit -m "docs: accept yuxi baseline deployment"
```

Expected: 阶段 1 结论为 PASS；Git 提交不含 `artifacts/acceptance/`、`.env`、真实文档正文或凭据。只有此提交存在后才进入阶段 2。
