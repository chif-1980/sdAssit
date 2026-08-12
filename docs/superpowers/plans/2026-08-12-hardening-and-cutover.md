# 安全加固、恢复演练与正式切换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成安全、故障恢复、真实飞书、桌面/移动浏览器和回退验收，在用户明确批准后让 React + FastAPI 成为唯一正式入口并停用旧 Fastify。

**Architecture:** 用同源 Nginx 容器提供 React 并代理统一 FastAPI，技术 Vue 保留独立管理员端口。自动安全测试覆盖凭据、ACL、附件和日志；备份脚本只读取 PostgreSQL/MinIO/配置清单并生成校验和，恢复必须进入新建验证目录/数据库。切换使用书面 GO/NO-GO 门禁，旧代码和备份保留但不再由正式启动脚本运行。

**Tech Stack:** React/Vite、Nginx、FastAPI、Docker Compose、PostgreSQL pg_dump/pg_restore、MinIO mc、Milvus rebuild、Redis/ARQ、pytest、Vitest、Playwright/浏览器验收、飞书开放平台。

---

## 文件结构

```text
KnowledgeBase/
├── docker/product-web.Dockerfile
├── docker/nginx.conf
├── package.json
├── vite.config.ts
└── docs/operations/legacy-fastify.md

KnowledgeBase-Yuxi/
├── compose.phase1.yml
├── scripts/
│   ├── backup_phase1.sh
│   ├── verify_backup.sh
│   ├── restore_to_validation.sh
│   └── rebuild_formal_index.py
├── docs/operations/
│   ├── backup-restore.md
│   ├── incident-response.md
│   ├── credential-rotation.md
│   ├── rollback.md
│   └── cutover-checklist.md
├── backend/package/yuxi/security/
│   ├── log_redaction.py
│   └── response_headers.py
└── backend/test/
    ├── unit/security/
    ├── integration/recovery/
    ├── e2e/platform/
    └── e2e/browser/
```

### Task 1: 构建同源 React 正式入口

**Files:**
- Create: `/Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase/docker/product-web.Dockerfile`
- Create: `/Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase/docker/nginx.conf`
- Modify: `/Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase/vite.config.ts`
- Modify: `compose.phase1.yml`（Yuxi 工程）
- Test: `backend/test/unit/deployment/test_product_web_contract.py`（Yuxi 工程）

- [ ] **Step 1: 写入口契约失败测试**

Create Yuxi `backend/test/unit/deployment/test_product_web_contract.py`:

```python
from pathlib import Path

import yaml

YUXI = Path(__file__).resolve().parents[4]
FRONTEND = YUXI.parent / "KnowledgeBase"


def test_product_web_builds_sibling_react_and_proxies_only_fastapi():
    config = yaml.safe_load((YUXI / "compose.phase1.yml").read_text())
    web = config["services"]["product-web"]
    assert web["build"]["context"] == "../KnowledgeBase"
    assert web["depends_on"]["api"]["condition"] == "service_healthy"
    nginx = (FRONTEND / "docker" / "nginx.conf").read_text()
    assert "proxy_pass http://api:5050/api/" in nginx
    assert "8787" not in nginx
```

- [ ] **Step 2: 运行测试确认失败**

Run in Yuxi: `cd backend && uv run pytest test/unit/deployment/test_product_web_contract.py -v`

Expected: FAIL，product-web 和 Docker 文件不存在。

- [ ] **Step 3: 创建多阶段 React/Nginx 镜像**

Create current repo `docker/product-web.Dockerfile`:

```dockerfile
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig*.json vite.config.ts vitest.config.ts ./
COPY src ./src
COPY shared ./shared
RUN npm run build

FROM nginx:1.27-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
HEALTHCHECK --interval=10s --timeout=3s --retries=10 CMD wget -qO- http://127.0.0.1/healthz || exit 1
```

Create `docker/nginx.conf`:

```nginx
server {
  listen 80;
  server_tokens off;
  root /usr/share/nginx/html;
  add_header X-Content-Type-Options nosniff always;
  add_header Referrer-Policy same-origin always;
  add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

  location = /healthz { access_log off; return 200 "ok\n"; }
  location /api/ {
    proxy_pass http://api:5050/api/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;
    proxy_read_timeout 600s;
  }
  location / { try_files $uri $uri/ /index.html; }
}
```

- [ ] **Step 4: 增加正式 product-web 服务**

Add Yuxi `compose.phase1.yml`:

```yaml
  product-web:
    build:
      context: ../KnowledgeBase
      dockerfile: docker/product-web.Dockerfile
    image: quickdone-knowledge-web:phase1
    container_name: quickdone-kb-product-web
    ports: ["127.0.0.1:4173:80"]
    depends_on:
      api: {condition: service_healthy}
    networks: [app-network]
    restart: unless-stopped
```

技术 Vue `web` 仍位于 5173，只面向技术管理员。FastAPI CORS 允许本机产品入口 4173，但业务浏览器采用同源 `/api`，不配置 `*`。

- [ ] **Step 5: 运行契约、构建和健康测试**

Run:

```bash
cd backend && uv run pytest test/unit/deployment/test_product_web_contract.py -v
cd ..
docker compose -f compose.phase1.yml --env-file .env up -d --build product-web
curl --fail --silent http://127.0.0.1:4173/healthz
curl --fail --silent http://127.0.0.1:4173/api/system/health
```

Expected: test PASS；两个 curl 成功；浏览器 API 请求 host 为 127.0.0.1:4173，不出现 8787。

- [ ] **Step 6: 分别提交入口配置**

Current React:

```bash
git add docker/product-web.Dockerfile docker/nginx.conf vite.config.ts
git commit -m "chore: serve product ui with fastapi proxy"
```

Yuxi:

```bash
git add compose.phase1.yml backend/test/unit/deployment/test_product_web_contract.py
git commit -m "chore: add product web deployment"
```

### Task 2: 加固凭据、日志、响应头与错误响应

**Files:**
- Create: `backend/package/yuxi/security/__init__.py`
- Create: `backend/package/yuxi/security/log_redaction.py`
- Create: `backend/package/yuxi/security/response_headers.py`
- Modify: `backend/server/main.py`
- Test: `backend/test/unit/security/test_log_redaction.py`
- Test: `backend/test/unit/security/test_response_headers.py`
- Test: `backend/test/unit/security/test_error_sanitization.py`

- [ ] **Step 1: 写秘密泄露失败测试**

日志测试输入含合成值 `Authorization: Bearer synthetic.jwt.value`、`app_secret`、`refresh_token`、`OPENAI_API_KEY=sk-test-only`、飞书 code 和文档正文标记，断言输出只保留 `[REDACTED]`/错误码/request_id。响应测试断言 CSP、nosniff、same-origin referrer、禁止 iframe；500 响应不含堆栈、SQL、MinIO key、模型响应或环境变量。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && uv run pytest test/unit/security -v`

Expected: FAIL，security 模块不存在。

- [ ] **Step 3: 实现结构化脱敏过滤器**

`redact(value)` 递归处理 dict/list/string，key 命中 `authorization,cookie,set-cookie,secret,token,password,api_key,access_token,refresh_token` 时替换；string 正则隐藏 Bearer/JWT/sk-/dotenv secret。错误日志只允许：`request_id,actor_uid_hash,route,status,error_code,job_id,aggregate_id,duration_ms`。不要记录用户问题、附件正文、引用 excerpt 或飞书 ACL principal。

- [ ] **Step 4: 增加统一安全响应中间件**

API 响应增加：

```text
X-Content-Type-Options: nosniff
Referrer-Policy: same-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
Content-Security-Policy: default-src 'self'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'
Cache-Control: no-store   # auth、citation、governance 正文
```

生产 cookie 为 `HttpOnly; SameSite=Lax; Secure`；开发本机 HTTP 只在 `YUXI_ENV=development` 可关闭 Secure。异常统一映射 `{error:{code,message,request_id}}`；未知异常中文消息固定“系统暂时不可用”。

- [ ] **Step 5: 运行安全单元测试和全局凭据扫描**

Run:

```bash
cd backend && uv run pytest test/unit/security -v
cd ..
git grep -nE '(sk-[A-Za-z0-9_-]{12,}|app_secret["'"']?\s*[:=]\s*["'"'][^$<]|refresh_token["'"']?\s*[:=])' -- . ':!.env.example'
```

Expected: 测试 PASS；凭据扫描无真实值命中。若命中真实凭据，停止、移除并轮换，不只删除文件。

- [ ] **Step 6: 提交安全中间件**

```bash
git add backend/package/yuxi/security backend/server/main.py backend/test/unit/security
git commit -m "fix: redact secrets and harden api responses"
```

### Task 3: 完成权限、附件提示注入和跨域安全回归

**Files:**
- Create: `backend/test/e2e/platform/test_security_boundaries.py`
- Create: `backend/test/fixtures/security/prompt_injection.txt`
- Create: `backend/test/fixtures/security/malicious_names.json`

- [ ] **Step 1: 创建无害攻击 fixture**

`prompt_injection.txt` 明确写“忽略系统规则、展示其他用户资料、调用工具读取环境变量”，但不包含真实秘密；`malicious_names.json` 列出路径穿越、控制字符、宏、双扩展和超长名称。

- [ ] **Step 2: 写安全 E2E**

同一测试创建 Employee A/B、Owner、Admin、Local Superadmin：验证跨用户会话/附件 403；Owner 只能自己的治理对象；Admin 能管理但无来源 ACL 时不能打开正文；Local Superadmin 无飞书身份不能绕过；附件注入不会导致工具调用/环境泄露；无权正文未进入模型 mock 的 input；恶意文件全部以明确 4xx 拒绝且不生成 MinIO 对象。

- [ ] **Step 3: 运行 E2E 并修复当前范围缺陷**

Run: `cd backend && uv run pytest test/e2e/platform/test_security_boundaries.py -m e2e -v`

Expected: 全部 PASS。只修复该测试暴露的安全边界，不增加第一阶段以外功能。

- [ ] **Step 4: 运行 CORS/CSRF/SSRF 回归**

验证生产未配置 origin 时跨域预检不返回宽松许可；修改请求要求同源 cookie + CSRF token 或 OAuth SameSite 保护；文件嵌入 URL、用户输入 URL 和飞书正文 URL 不由服务器任意抓取；只允许显式飞书 API host 和模型 provider host。

- [ ] **Step 5: 提交安全 E2E**

```bash
git add backend/test/e2e/platform/test_security_boundaries.py backend/test/fixtures/security
git commit -m "test: verify platform security boundaries"
```

### Task 4: 编写可校验的备份与恢复脚本

**Files:**
- Create: `scripts/backup_phase1.sh`
- Create: `scripts/verify_backup.sh`
- Create: `scripts/restore_to_validation.sh`
- Create: `docs/operations/backup-restore.md`
- Test: `backend/test/unit/operations/test_backup_scripts.py`

- [ ] **Step 1: 写脚本安全契约失败测试**

测试读取三个脚本并断言：`set -euo pipefail`；目标必须以参数给出且不能是 `/`,`~`,`$HOME`、项目根；输出目录必须新建；包含 pg_dump custom format、MinIO mirror、manifest SHA-256；备份不复制 `.env`；恢复目标数据库固定后缀 `_restore_verify` 且先检查不存在；脚本不含 `rm -rf`、`make reset` 或 drop 生产库。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && uv run pytest test/unit/operations/test_backup_scripts.py -v`

Expected: FAIL，脚本不存在。

- [ ] **Step 3: 实现 backup_phase1.sh**

脚本接收一个绝对、尚不存在的输出目录，拒绝宽泛路径；创建：

```text
backup-YYYYmmdd-HHMMSS/
├── postgres/yuxi.dump
├── minio/evidence/
├── metadata/yuxi-commit.txt
├── metadata/react-commit.txt
├── metadata/compose-config-redacted.yml
├── metadata/migrations.txt
├── metadata/collections.json
├── manifest.sha256
└── RESTORE_REQUIRED_SECRETS.txt
```

使用 `docker compose exec -T postgres pg_dump --format=custom --no-owner --no-acl`；用临时 `mc` alias mirror 证据/会话对象（过期 session 可不备份，但在清单记录）；Compose config 先经脱敏过滤；不复制 `.env`。先令 `BACKUP_DIR` 等于已验证的新备份绝对路径，再运行 `find "$BACKUP_DIR" -type f -print0 | sort -z | xargs -0 shasum -a 256`。

- [ ] **Step 4: 实现校验和隔离恢复**

`verify_backup.sh` 只运行 `shasum -a 256 -c`、`pg_restore --list` 和 manifest 完整性检查。`restore_to_validation.sh` 要求明确备份目录和新建临时 MinIO prefix；验证当前数据库名不是生产 `yuxi`，创建 `yuxi_restore_verify`，pg_restore 到该库，并 mirror 到 `restore-verify-{timestamp}` prefix。验证完成只输出人工清理命令，不自动删除恢复物。

- [ ] **Step 5: 编写操作手册**

`backup-restore.md` 写明：每日/切换前备份、所需磁盘、秘密另行安全保管、命令、预期文件、验证、恢复、RTO 第一阶段 4 小时/RPO 最近一次成功备份、清理需人工确认、Milvus/Redis 不备份而重建。

- [ ] **Step 6: 运行脚本契约和 shell 语法测试**

Run:

```bash
cd backend && uv run pytest test/unit/operations/test_backup_scripts.py -v
cd ..
bash -n scripts/backup_phase1.sh scripts/verify_backup.sh scripts/restore_to_validation.sh
```

Expected: 全部 PASS。

- [ ] **Step 7: 提交备份恢复能力**

```bash
git add scripts/backup_phase1.sh scripts/verify_backup.sh scripts/restore_to_validation.sh \
  docs/operations/backup-restore.md backend/test/unit/operations/test_backup_scripts.py
git commit -m "feat: back up and verify business evidence"
```

### Task 5: 演练 Worker、Redis、Milvus、MinIO 和 PostgreSQL 故障

**Files:**
- Create: `scripts/rebuild_formal_index.py`
- Create: `backend/test/integration/recovery/test_worker_restart.py`
- Create: `backend/test/integration/recovery/test_redis_loss.py`
- Create: `backend/test/integration/recovery/test_milvus_rebuild.py`
- Create: `backend/test/integration/recovery/test_minio_evidence_loss.py`
- Create: `backend/test/integration/recovery/test_postgres_outage.py`

- [ ] **Step 1: 写五类恢复测试**

每个测试使用专用 fixture，分别断言：Worker 在 RUNNING 中停止后 Job 重派且不重复对象；Redis `FLUSHDB` 后 Outbox 恢复；drop formal collection 后从 PostgreSQL 重建；缺失 MinIO evidence 使相关 Knowledge STALE/停止召回并创建 SOURCE_CHANGE Review；PostgreSQL 停止时写入 503 且不回退 JSON，恢复后事务正常。

- [ ] **Step 2: 运行测试确认至少一项失败**

Run: `cd backend && uv run pytest test/integration/recovery -m integration -v`

Expected: 首次至少一个测试 FAIL，指出缺少恢复编排；若全部意外通过，先核实测试确实执行了故障动作而非被 skip。

- [ ] **Step 3: 实现索引重建命令**

`scripts/rebuild_formal_index.py` 参数：`--index-version`、`--embedding-model`、`--confirm REBUILD_FORMAL_INDEX`。先从 PostgreSQL count 当前可用 versions，创建新 collection，分页重建并验证 entity/version 覆盖率，最后切 active index version。无 confirm 只 dry-run；失败保留旧 collection 和 active version。

- [ ] **Step 4: 实现恢复缺口**

Worker startup 将超时 RUNNING Job 转 RETRY_WAIT 并补 Outbox；dispatcher 每 30 秒扫描未投递；ACL/source invalidation 走 PostgreSQL 同步失效；MinIO 404 不再让知识继续召回；Postgres session failure 映射 503，不捕获后写本地文件。

- [ ] **Step 5: 运行全部恢复测试**

Run: `cd backend && uv run pytest test/integration/recovery -m integration -v`

Expected: 全部 PASS，且测试后 Redis、Milvus、MinIO、PostgreSQL 容器恢复 healthy。

- [ ] **Step 6: 提交恢复编排**

```bash
git add scripts/rebuild_formal_index.py backend/test/integration/recovery backend/package/yuxi
git commit -m "feat: recover durable jobs and rebuild indexes"
```

### Task 6: 执行真实备份、隔离恢复和回退演练

**Files:**
- Create: `docs/operations/rollback.md`
- Modify: `docs/implementation/acceptance-log.md`

- [ ] **Step 1: 创建明确的新备份目录**

Run:

```bash
mkdir -p /Users/apple/Documents/Codex/projects/Quickdone/backups
test ! -e /Users/apple/Documents/Codex/projects/Quickdone/backups/knowledge-platform-pre-cutover-20260812
./scripts/backup_phase1.sh /Users/apple/Documents/Codex/projects/Quickdone/backups/knowledge-platform-pre-cutover-20260812
```

Expected: 新目录创建，生产目录未变化；脚本不覆盖同名备份。

- [ ] **Step 2: 校验并恢复到隔离目标**

Run:

```bash
./scripts/verify_backup.sh /Users/apple/Documents/Codex/projects/Quickdone/backups/knowledge-platform-pre-cutover-20260812
./scripts/restore_to_validation.sh /Users/apple/Documents/Codex/projects/Quickdone/backups/knowledge-platform-pre-cutover-20260812
```

Expected: 校验和、pg_restore list、验证数据库行数、MinIO 抽样 hash 全部 PASS；生产 `yuxi` 库和 evidence prefix 未被覆盖。

- [ ] **Step 3: 写精确回退手册**

`rollback.md` 包含触发条件（登录/ACL/数据完整性/问答严重故障）、停止 product-web/API/worker、保留数据库/MinIO、启动旧 Fastify 与旧 React 的命令、验证 `/api/session` 和演示问答、恢复新系统的命令、负责人和最长决策时间。回退不删除新数据。

- [ ] **Step 4: 演练旧原型回退再切回**

在维护窗口停止 `product-web`（不停止数据容器），从当前 React 工程用旧脚本临时启动 Fastify 和 Vite，验证旧演示；停止旧进程，再启动 product-web/API/worker，验证新会话和正式知识。

Expected: 两次切换均成功；失败则最终切换为 NO-GO。演练不移动或删除源码。

- [ ] **Step 5: 记录恢复证据并提交**

```bash
git add docs/operations/rollback.md docs/implementation/acceptance-log.md
git commit -m "docs: verify backup restore and rollback"
```

Expected: 记录只有命令、时间、对象数量和 PASS/FAIL，不含正文/凭据。

### Task 7: 完成真实飞书、Q900、客户需求与浏览器总验收

**Files:**
- Create: `backend/test/e2e/platform/test_final_acceptance.py`
- Create: `backend/test/e2e/browser/test_product_workflows.py`
- Modify: `docs/implementation/acceptance-log.md`

- [ ] **Step 1: 写最终 API E2E 聚合测试**

聚合测试复用已通过 fixture，不复制逻辑；依次验证飞书 dry-run、受控正式同步、Candidate/Review/Publish、Q900 V1/V2、三范围问答、客户需求逐条响应、双引用、反馈 Review、撤权、24h 过期、Worker/Redis/Milvus 恢复。每个子步骤有独立断言和清理 ID。

- [ ] **Step 2: 运行最终 API E2E**

Run:

```bash
cd backend
RUN_REAL_FEISHU_E2E=1 uv run pytest test/e2e/platform/test_final_acceptance.py -m e2e -v
```

Expected: PASS；真实飞书段只读，输出不含标题、正文、ACL 或用户 ID。

- [ ] **Step 3: 编写浏览器工作流测试**

测试使用专用测试账号/合成资料，覆盖：飞书登录回调、Employee chat、上传/进度/失败、三范围、SSE、双引用、反馈；Owner 资料/审核/diff/完成/版本；Admin 同步/Job/ACL 异常；底部输入框；1440×900 和 390×844。断言页面无 `Chunk,Embedding,Top-K,Milvus,prompt` 技术词。

- [ ] **Step 4: 执行自动和人工浏览器 QA**

Run product at `http://127.0.0.1:4173`，执行浏览器测试并保存脱敏截图到 ignored `artifacts/acceptance/final-browser/`。人工检查浅蓝色、透明低对比分割线、键盘 focus、中文错误信息、移动端可触达。

Expected: 所有自动断言通过；人工清单逐项 PASS；网络面板没有 8787、MinIO、Milvus 或外部模型直连。

- [ ] **Step 5: 运行两仓库全量质量门禁**

Yuxi:

```bash
make test
make lint
cd backend && uv run pytest -m unit
uv run pytest -m integration
uv run pytest -m e2e
cd ../web && pnpm run test:unit && pnpm run build
```

React:

```bash
npm run test:run
npm run typecheck
npm run build
```

Expected: 所有命令退出码 0；没有用 skip/xfail 隐藏本阶段测试失败。

- [ ] **Step 6: 生成最终 PASS/FAIL 表**

`acceptance-log.md` 按规格最终 12 条验收逐项列：结果、测试/人工证据、完成时间、剩余风险。任一 FAIL 或真实飞书未执行则整体 NO-GO，不请求停用旧 Fastify。

- [ ] **Step 7: 提交最终验收测试和记录**

```bash
git add backend/test/e2e/platform/test_final_acceptance.py backend/test/e2e/browser/test_product_workflows.py \
  docs/implementation/acceptance-log.md
git commit -m "test: complete platform acceptance"
```

### Task 8: 经明确确认后停用旧 Fastify

**Files:**
- Modify: `/Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase/package.json`
- Modify: `/Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase/vite.config.ts`
- Create: `/Users/apple/Documents/Codex/projects/Quickdone/KnowledgeBase/docs/operations/legacy-fastify.md`
- Modify: `docs/operations/cutover-checklist.md`（Yuxi 工程）

- [ ] **Step 1: 向用户展示 GO/NO-GO 决策包**

展示：12 条结果、两仓库提交号、真实根节点验收、备份路径/校验、回退演练、已知风险和实际切换动作。明确说明：下一动作只停用正式脚本中的 Fastify，不删除 `server/`、JSON、Git 历史或备份。

- [ ] **Step 2: 等待用户明确批准**

只有用户明确回复同意正式切换/停用旧 Fastify 才继续。普通“通过”、阶段测试 PASS 或先前设计确认不替代本次切换授权；未获批准时停在这里，系统保持并行可恢复状态。

- [ ] **Step 3: 先写停用行为失败测试**

修改/新增 `src/app/App.test.tsx` 或脚本契约测试，断言 `package.json` 正式 `dev` 不启动 `dev:server`，Vite `/api` 代理为 FastAPI `http://127.0.0.1:5050`，没有正式 script 指向 `server/index.ts`。保留旧源码但不在默认/正式命令运行。

- [ ] **Step 4: 停用正式 Fastify 启动脚本**

`package.json` 调整：

```json
{
  "scripts": {
    "dev": "vite",
    "dev:web": "vite",
    "test": "vitest",
    "test:run": "vitest run --passWithNoTests",
    "typecheck": "tsc -p tsconfig.web.json --noEmit",
    "build": "npm run typecheck && vite build"
  }
}
```

`vite.config.ts` 开发 proxy `/api -> http://127.0.0.1:5050`。删除 `dev:server`/`server`/默认 concurrently 引用，但不删除 Fastify dependencies/source/tests，避免扩大切换范围；`legacy-fastify.md` 记录它们仅为恢复样例，不承担正式数据。

- [ ] **Step 5: 验证只运行统一 FastAPI**

Run:

```bash
npm run test:run
npm run typecheck
npm run build
npm run dev
```

在另一终端：

```bash
lsof -nP -iTCP:8787 -sTCP:LISTEN
curl --fail --silent http://127.0.0.1:5050/api/system/health
curl --fail --silent http://127.0.0.1:4173/api/system/health
```

Expected: 前三项 PASS；8787 无监听；5050/4173 健康；浏览器所有业务 API 指向 FastAPI。

- [ ] **Step 6: 提交旧后端停用**

Current React:

```bash
git add package.json package-lock.json vite.config.ts docs/operations/legacy-fastify.md src/app/App.test.tsx
git commit -m "chore: retire fastify from formal startup"
```

Yuxi:

```bash
git add docs/operations/cutover-checklist.md
git commit -m "docs: record approved platform cutover"
```

Expected: 两仓库干净；旧源码仍可从 Git/备份恢复；Fastify 已停止承担正式业务。

### Task 9: 切换后观察和最终完成判定

**Files:**
- Modify: `docs/operations/incident-response.md`
- Modify: `docs/implementation/acceptance-log.md`

- [ ] **Step 1: 连续观察关键指标**

在至少一个完整业务验证窗口记录：API 5xx/延迟、Job NEEDS_ATTENTION、同步差异、ACL_UNAVAILABLE、问答 INSUFFICIENT/CONFLICTING、模型失败、MinIO/Milvus/PostgreSQL/Redis health。第一阶段本机部署以人工/日志聚合记录，不引入新的监控平台。

- [ ] **Step 2: 运行切换后 smoke**

用 Employee/Owner/Admin 各执行一个非破坏工作流；上传合成附件并删除；打开企业引用触发实时 ACL；触发一次 dry-run sync；重启 API/worker 后验证任务恢复。

Expected: 全部 PASS；无秘密和正文出现在普通日志。

- [ ] **Step 3: 判定完成或回退**

出现数据完整性、越权、持续登录失败或正式知识错误召回时，按 `rollback.md` 回退，不边运行边修复高风险问题。全部稳定后把阶段 6 和整体状态改为 PASS。

- [ ] **Step 4: 提交最终状态**

```bash
git add docs/operations/incident-response.md docs/implementation/acceptance-log.md
git commit -m "docs: complete knowledge platform cutover"
```

Expected: 最终 12 条验收均 PASS，且无未处理高风险项；到此第一阶段才算完成。
