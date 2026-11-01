# mcp-credit-gateway

独立 Cloudflare Worker：给 MCP 客户端提供 PDF/图片转 Markdown、OCR、表格提取工具，并在每次工具调用前从 ImgKits 积分账户扣分。

> **Deploy note:** `wrangler.jsonc` ships with placeholder D1 / KV ids. Create your own D1+KV (or fill production ids privately) before `wrangler deploy`. Never commit `.dev.vars`, `secrets/`, or real `TICKET_ENCRYPTION_KEY` / `ADMIN_TOKEN` / `MINERU_S2S_BEARER`.

> **Powered by MinerU (opendatalab/MinerU).**
> MinerU license: https://github.com/opendatalab/MinerU/blob/master/LICENSE.md
>
> 本仓库是独立 Worker，不修改业务仓，不打包 MinerU 源码或模型权重。MinerU 由单独运营的服务处理；上游任务数据临时保存，声明保留时间 ≤24h。

## 公开入口

| 入口 | 地址 |
|---|---|
| 介绍页 | `https://mcp.imgkits.com/` |
| MCP | `POST https://mcp.imgkits.com/mcp` |
| 隐私政策 | `https://www.imgkits.com/privacy` |
| 隐私短页 | `https://mcp.imgkits.com/privacy`，指向上面的 ImgKits 隐私政策 |
| workers.dev | `https://mcp-credit-gateway.<your-subdomain>.workers.dev/`，`/mcp`、`/privacy` 同路径可用 |

传输方式是 **MCP Streamable HTTP**，无状态 JSON 响应（`POST /mcp`）。`GET /mcp` 返回 405，不支持 SSE 流或 session。

## MCP 工具

| 工具 | 用途 | 返回 |
|---|---|---|
| `convert_to_markdown` | PDF / 图片 → 干净 Markdown，适合 RAG、LLM 入库。可选返回 MinerU 版面 JSON。 | `markdown`，可选 `layout_json` |
| `ocr_image` | 图片、截图、扫描页 → 文本块，带 block 级 bounding box。 | `blocks[]`（`type`、`text`、`bbox`、`page_idx`） |
| `extract_tables` | PDF / 图片 → 表格 HTML 加行列矩阵，合并单元格展开。 | `tables[]`（`html`、`rows`、`row_count`、`column_count`、`page_idx`、`bbox`） |

输入限制：

- 每次 1–5 个文件。
- 每个文件 ≤20 MiB。
- 只接受公开 `https://` URL，且 URL 必须直接指向 `pdf`、`png`、`jpg`、`jpeg`、`webp`、`bmp`、`tif`、`tiff` 文件。
- 本期不支持 DOCX。私有、本地、link-local、metadata、单标签主机、带凭据的 URL 和非默认端口都会被拒绝。

本 Worker 不保存文件内容和结果。工具输出里包含 `retention` 和 `attribution` 字段，其中保留时间声明为 ≤24h，署名指向 MinerU 及其 LICENSE。

配置 `MCP_TRANSMONKEY_UPSTREAM` 和/或 `MCP_MARKANY_UPSTREAM` 后，同一 `/mcp` 端点还会聚合对应上游工具；三个本地工具名保持不变，上游工具名直接转发（不使用名称前缀）。

## 获取 API Key

**API Key 由小助理人工代发，本服务没有自助签发页面。** 需要试用时联系小助理，提供 ImgKits 账号信息；签发后得到一把 `sk_live_…` Key，只在签发响应里出现一次。

```http
Authorization: Bearer sk_live_...
```

不要提交 Key 到仓库、前端或公开日志。泄露时联系小助理吊销并重新签发。同一用户最多保留 2 把未吊销 Key，再签会自动吊销最早的一把。

## 计费方式

MCP 工具调用和 `/v1/*` 使用同一套 Key、同一套扣分逻辑：

1. 校验参数、URL、文件数量，并尽量用 `HEAD` 检查大小。
2. 通过现有 `UserLock` Durable Object 扣分，等价于 `POST /v1/charge`，幂等键为本次 `job_id`。
3. 扣分成功后才调用 MinerU `create`，再轮询 `result/{task_id}`。
4. 返回过滤后的结果。

默认每次工具调用 1 积分（可选 `MCP_CHARGE_COST` 覆盖，默认 `1`）。没有自动退款：扣分成功后上游失败，错误里会带 `charged: true`、`job_id`、`task_id`，由小助理人工核对处理。

| 扣分结果 | MCP 错误码 | 含义 |
|---|---|---|
| 401 | `unauthorized` | Key 无效或已吊销 |
| 402 | `insufficient_credits` | 余额不足，未调用 MinerU |
| 409 | `idempotency_conflict` | 幂等键冲突 |
| 429 | `rate_limited` | 每分钟 60 次或日扣分上限 500 |
| 503 | `charge_unavailable` | 扣分服务不可用或结果不确定 |
| 其他 | `charge_failed` | 未预期的扣分失败 |

`/v1/refund` 固定返回 404。人工退分在 ImgKits 侧处理。

## HTTP 接口

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| `GET` | `/` | 无 | 公开 HTML 介绍页 |
| `GET` | `/privacy` | 无 | 短 HTML，指向 `https://www.imgkits.com/privacy` |
| `POST` | `/mcp` | `tools/call` 需要 Bearer；`initialize` / `tools/list` / `ping` 公开 | MCP JSON-RPC |
| `GET` / `DELETE` | `/mcp` | — | `405 Method Not Allowed` |
| `OPTIONS` | 任意 | — | CORS 预检 |
| `GET` | `/v1/me` | Bearer | Key 对应用户信息 |
| `GET` | `/v1/balance` | Bearer | 查询 ImgKits 余额 |
| `POST` | `/v1/charge` | Bearer + `Idempotency-Key` | 扣分 |
| `POST` | `/v1/admin/keys` | `X-Admin-Token` | 小助理签发 Key |
| `GET` | `/v1/admin/keys?usa_user_id=…` | `X-Admin-Token` | 列出 Key |
| `POST` | `/v1/admin/keys/{id}/revoke` | `X-Admin-Token` | 吊销 Key |
| `GET` | `/v1/admin/ledger?status=…` | `X-Admin-Token` | 查看扣分流水/待退分队列 |

`/v1/*` 的路径、请求体和返回结构保持原样；本次只新增 MCP 和公开页面，不改动既有扣分逻辑。

### MCP curl 示例

```bash
export MCP_URL="https://mcp.imgkits.com/mcp"
export API_KEY="sk_live_REPLACE_ME"

# initialize（公开）
curl -sS "$MCP_URL" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}'

# tools/list（公开；配置挂载钩子后会合并 TransMonkey / MarkAny 上游工具）
curl -sS "$MCP_URL" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# tools/call（需要 Key，先扣分再调用 MinerU）
curl -sS "$MCP_URL" \
  -H "authorization: Bearer $API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "jsonrpc":"2.0",
    "id":3,
    "method":"tools/call",
    "params":{
      "name":"convert_to_markdown",
      "arguments":{"files":["https://example.com/sample.pdf"],"include_layout_json":false}
    }
  }'
```

## 本地运行

```bash
npm install
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，填入 secret。不要提交 .dev.vars。
npm test
npx wrangler d1 migrations apply mcp-credit-gateway --local
npm run dev
```

本地开发服务监听 `http://localhost:43123`。`npm test` 不需要 Cloudflare 账号，也不需要 `.dev.vars`；测试夹具只用于本地 Vitest，不是生产密钥。

## 配置

### 绑定

| 名称 | 类型 | 作用 |
|---|---|---|
| `DB` | D1 `mcp-credit-gateway` | `api_keys`、`ledger` |
| `KEY_CACHE` | KV | Key 元数据缓存，TTL 60 秒，不含 ticket |
| `USER_LOCK` | Durable Object `UserLock`（SQLite） | 按 `usa_user_id` 串行扣分 |
| `USA_BASE_URL` | var | usa 源站 |
| `USA_TIMEOUT_MS` | var | 单次 usa 调用超时，100–15000ms |
| `MINERU_BASE_URL` | var | MinerU 网关地址，公开常量 |
| `MCP_TRANSMONKEY_UPSTREAM` | var | 可选挂载上游 MCP 基址（不带结尾斜杠）；设置后聚合 TransMonkey 工具 |
| `TRANSMONKEY_MCP` | service binding | 指向 Worker `mcp-transmonkey`；避开 workers.dev CF 1042 |
| `MCP_MARKANY_UPSTREAM` | var | 可选挂载上游 MCP 基址（不带结尾斜杠）；设置后聚合 MarkAny 水印工具 |
| `MARKANY_MCP` | service binding | 指向 Worker `mcp-markany`；避开 workers.dev CF 1042 |

本仓 `wrangler.jsonc` 新增 `MINERU_BASE_URL`、`MCP_TRANSMONKEY_UPSTREAM`、`MCP_MARKANY_UPSTREAM` var 和 `MINERU_S2S_BEARER` secret 名。`MINERU_CHANNEL` 与 `MCP_CHARGE_COST` 是代码可选覆盖项，未写入 wrangler；不设置时分别表示不带 channel 头、每次扣 1 分。

### Secret

| 名称 | 必需 | 作用 |
|---|---|---|
| `TICKET_ENCRYPTION_KEY` | 是 | AES-256-GCM 密钥，解码后 32 字节 |
| `ADMIN_TOKEN` | 是 | 小助理 `X-Admin-Token`，至少 16 字符 |
| `MINERU_S2S_BEARER` | 是 | 单独签发的 MinerU 服务端 Bearer |
| `GATEWAY_SHARED_SECRET` | 否 | 可选；转发上游时作为 `X-Gateway-Shared-Secret` |

`MINERU_S2S_BEARER` 禁止复用前端旧 MinerU Key、RapidAPI/proxy token 或任何旧网关 Key。只通过 `wrangler secret put` 或本地 `.dev.vars` 设置，不要写进 `wrangler.jsonc`、源码、测试或 README。

### 可选挂载钩子

`/mcp` 支持两个互相独立的上游挂载。`wrangler.jsonc` 默认两个都已配置；未设置对应 var 时该上游不启用。

| 上游 | 开关 var | Service Binding | 默认工具 |
|---|---|---|---|
| TransMonkey | `MCP_TRANSMONKEY_UPSTREAM` | `TRANSMONKEY_MCP → mcp-transmonkey` | `translate_text`、`translate_document`、`translate_image`、`translate_subtitle`、`detect_language` |
| MarkAny | `MCP_MARKANY_UPSTREAM` | `MARKANY_MCP → mcp-markany` | `add_watermark`、`remove_watermark`、`embed_blind_watermark`、`decode_blind_watermark` |

通用行为：

- Cloudflare 禁止 Worker 经公网互打 `*.workers.dev`（错误码 **1042**）。生产转发必须走 Service Binding；`MCP_*_UPSTREAM` 作开关/文档基址，binding 负责实际 `fetch`。Service Binding 请求会补 `Host`。
- `initialize` / `tools/list` / `ping` 仍公开；**无 Bearer 的 `tools/list` 也会合并已配置的上游工具**。两个上游都配置且都可用时为 12 个：3 本地 + 5 TransMonkey + 4 MarkAny。
- 合并顺序固定为本地工具 → TransMonkey → MarkAny；重名工具只保留先出现的那个。
- 每个上游的 `tools/list` 独立 fail-open：失败或 8 秒超时只记 warn，并返回其余工具，不会 500。
- `tools/call` 仍要 Bearer；转发前先按本仓同一套 `UserLock` 扣分，扣分成功后才请求上游；上游调用超时 120 秒。
- 转发时带 `X-Access-Channel: mcp-gateway`、`X-Mcp-Charge-Id`、可选 `X-Gateway-Shared-Secret`；`tools/call` 另带同请求的 `Authorization: Bearer`。
- 扣分成功后上游失败或返回 JSON-RPC 错误时，返回 `isError: true`，`structuredContent` 带 `charged: true` 和 `charge_id`；没有自动退款。
- `GATEWAY_SHARED_SECRET` 是可选 secret，设置后同时用于两个上游的 `tools/list` 和 `tools/call`。不要把它写进源码或 `wrangler.jsonc`。

路由与费用：

- `convert_to_markdown`、`ocr_image`、`extract_tables` 始终留在本 Worker，使用本地 MinerU 路径和 `MCP_CHARGE_COST`（默认 1）。
- 四个 MarkAny 固定工具名在 MarkAny 已配置时先扣 1 分再转发到 MarkAny，固定 1 分，不受 `MCP_CHARGE_COST` 影响。
- 其余非本地工具名在 TransMonkey 已配置时转发 TransMonkey；TransMonkey 上游返回的动态工具名同样转发，不使用名称前缀。
- TransMonkey 费用：`translate_document` / `translate_image` 5 分，其余上游工具 1 分；同样不使用 `MCP_CHARGE_COST`。
- TransMonkey 未配置时，MarkAny 四个固定名之外的非本地工具名返回 `tool_not_found`，不扣分。

### 部署

部署由后端岗在本机执行，本仓库不自动部署：

```bash
npm run typecheck
npm test
npx wrangler d1 migrations apply mcp-credit-gateway --remote

openssl rand -base64 32 | npx wrangler secret put TICKET_ENCRYPTION_KEY
openssl rand -base64 32 | npx wrangler secret put ADMIN_TOKEN
# 使用单独签发的值，不要复用任何旧 Key。
npx wrangler secret put MINERU_S2S_BEARER

npx wrangler deploy
```

`wrangler.jsonc` 中已有 `mcp.imgkits.com` 的 custom domain route；本次不新增 route，也不新增 custom domain。workers.dev 默认开启。

`TICKET_ENCRYPTION_KEY` 接受标准 base64、base64url 或 64 位 hex。轮换后旧 ticket 无法解密，对应 Key 扣分时会返回 500，需要小助理重新签发。

## 小助理运维

签发（注意 `from_app` 用 `imgkit`，`ticket` 是该用户当前的 `X-Access-Ticket`）：

```bash
curl -sS http://localhost:43123/v1/admin/keys \
  -H "content-type: application/json" \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -d '{"usa_user_id":"USER_ID","from_app":"imgkit","ticket":"TK...","email_masked":"a***@example.com"}'
```

响应里的 `key` 只出现一次。数据库只有 SHA-256 和 `sk_live_` 加 4 位 hex 的前缀。

```bash
curl -sS -X POST http://localhost:43123/v1/admin/keys/KEY_ID/revoke \
  -H "x-admin-token: $ADMIN_TOKEN"

curl -sS "http://localhost:43123/v1/admin/keys?usa_user_id=USER_ID" \
  -H "x-admin-token: $ADMIN_TOKEN"

curl -sS "http://localhost:43123/v1/admin/ledger?status=pending_refund" \
  -H "x-admin-token: $ADMIN_TOKEN"
```

`pending_refund` 是 `pending_manual_refund` 的别名。待退分队列最多 100 条，按时间从早到晚。

## 扣分与数据模型

扣分在 `getByName(usa_user_id)` 的 Durable Object 队列里串行执行：

1. 再读 D1；已吊销返回 401 并删 KV。
2. 每把 Key 每分钟最多 60 次请求。超限返回 429，幂等重放也计数。
3. 按 `(usa_user_id, idempotency_key)` 查 ledger；命中且 `cost`/`tool`/`ref` 相同则重放首次结果，不同返回 409。
4. 日额度：每把 Key 和每个用户在 UTC 日各不超过 500 分。
5. 解密 ticket，查 usa 余额；`free_cnt < cost` 返回 402，不调用扣分。
6. `/api/order/download` 成功后才记 `charged`，并更新当日已扣分。
7. 超时、网络错误、3xx、或 2xx 但认不出成功信号时，记为 `pending_manual_refund`，不向调用方报告成功。

表结构见 `migrations/0001_init.sql`：

- `api_keys`：Key 哈希/前缀、用户映射、加密 ticket、脱敏邮箱、吊销时间、当日扣分。
- `ledger`：每次扣分的幂等键、成本、工具、引用、状态、余额前后值、错误、HTTP 状态和完整响应重放。

`status`：`in_flight`、`charged`、`failed_usa`、`pending_manual_refund`、`rejected_insufficient`。

工具扣分成功后失败时没有自动退分接口，小助理确认后人工处理：

```sql
UPDATE ledger
SET status = 'pending_manual_refund', error = 'tool_failed_after_charge'
WHERE id = 'CHARGE_ID' AND status = 'charged';
```

## 安全与隐私

- Key 明文只在签发响应中出现一次；数据库和 KV 都没有明文 Key。
- Ticket 只有 AES-GCM 密文落库，调用 usa 前才解密。
- 日志只打 Key 前缀、状态、扣分 ID；不打完整 Key、ticket、文件 URL、文件名或提取文本。
- 管理令牌用 SHA-256 后做固定时间比较；过短或空令牌拒绝。
- 吊销写 `revoked_at` 并删 KV；扣分路径每次再读 D1。
- 只能扣 Key 绑定的那个用户，没有加分接口。
- 不保存用户文件或结果；不提供公开结果桶。
- 完整隐私政策：`https://www.imgkits.com/privacy`；本 Worker 的 `/privacy` 只做短跳转说明。
- 不要提交 secret：`.dev.vars`、`.env`、`.wrangler/`、`secrets/` 已在 `.gitignore`。

## 测试

```bash
npm run typecheck
npm test
```

当前 Vitest 覆盖：

- `GET /` HTML、`GET /privacy` 短 HTML（包含 `https://www.imgkits.com/privacy`）。
- `POST /mcp` 的 `initialize`、`tools/list`、`ping`、未知方法、无效 JSON、`GET /mcp` 405、`tools/call` 缺 Bearer。
- MCP 工具先扣分再调用 MinerU、扣分失败不调用 MinerU、非法文件类型在扣分前拒绝。
- TransMonkey 挂载：`tools/list` 合并 3 个本地工具与上游工具、上游故障时 fail-open、`translate_text` 先扣分再转发、本地 `convert_to_markdown` 不外发、SSE 响应解包。
- MarkAny 挂载：两个上游同时可用时 `tools/list` 合并 3 + 5 + 4 = 12 个工具、MarkAny 单独故障时 fail-open、`add_watermark` 固定扣 1 分后转发、上游错误保留 charged/charge_id、本地工具不外发。
- `/v1/charge` 仍要求 Bearer 和幂等键；`/v1/admin/keys` 签发后 `/v1/me` 仍可用。

测试里的 usa、MinerU 和扣分调用都是本地假实现，不访问线上，也不需要真实 secret。

## 许可与署名

本仓库代码使用 MIT License，见 `LICENSE`。第三方署名见 `NOTICE`。

**Powered by MinerU (opendatalab/MinerU).** MinerU 4.x 使用 MinerU Open Source License（Apache-2.0 加附加条款）；上游模型权重和第三方组件可能另有许可。本仓库不打包 MinerU 源码、模型权重或其他上游资产，只调用单独运营的 MinerU 服务。MinerU LICENSE：https://github.com/opendatalab/MinerU/blob/master/LICENSE.md
