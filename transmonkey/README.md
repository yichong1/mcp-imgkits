# mcp-transmonkey

TransMonkey 翻译能力的独立 Cloudflare Worker + MCP Server。提供 5 个工具：文本、文档、图片、字幕翻译与语种检测。

- **唯一对外入口**：`https://mcp.imgkits.com/mcp`，由 `mcp-credit-gateway` 鉴权、扣分并转发到本 Worker。
- **挂载约定 A**：**扣分在 gateway**；本侧**禁止** `fetch` `/v1/charge`，只信任 gateway 已扣并透传 `charge_id`。
- **MCP 传输**：Streamable HTTP，本侧路由 `/mcp`，用 `agents` SDK 的 `createMcpHandler` + `@modelcontextprotocol/server` 的 stateless `McpServer`。
- **鉴权**：`initialize`、`tools/list`、`ping`、`notifications/*` **公开**，不需要 Bearer；只有 `tools/call` 等会执行计费/上游的方法要求 `Authorization: Bearer sk_live_…`。gateway 转发鉴权请求时附 `X-Access-Channel: mcp-gateway`。
- **上游**：Worker Secret `UPSTREAM_API_TOKEN`，新签 S2S Bearer；不使用任何前端写死密钥。
- **部署**：仅 `workers_dev: true`，没有 `routes` / `custom_domain`。workers.dev 只作灰度自测。
- **隐私 / 取 Key / 余额**：统一看网关页 <https://mcp.imgkits.com>；本 Worker 不签发 key、不存 key。

## 架构（gateway 扣分 + 转发）

```text
MCP 客户端 (Inspector / Claude / 自研 Agent)
  │  Authorization: Bearer sk_live_…
  │  POST https://mcp.imgkits.com/mcp
  ▼
mcp-credit-gateway
  │  1. 校验 sk_live_、扣分、处理 402/503
  │  2. 转发 MCP JSON-RPC 到 MCP_TRANSMONKEY_UPSTREAM
  │     X-Access-Channel: mcp-gateway
  │     Authorization: Bearer <同一把 sk_live_…>   (不落盘)
  │     X-Mcp-Charge-Id: <可选，扣分流水号>
  │     X-Gateway-Shared-Secret: <可选，配置了才校验>
  ▼
Cloudflare Worker (本仓，workers.dev)
  │  0. 解析 JSON-RPC：initialize / tools/list / ping / notifications/* 公开，直接进 MCP handler
  │     仅当任一方法为 tools/call 或未知需鉴权方法时才继续下面 1–3
  │  1. 校验 Bearer 必须以 sk_live_ 开头
  │  2. 若配置 GATEWAY_SHARED_SECRET，校验 X-Gateway-Shared-Secret
  │  3. 必须有 X-Access-Channel: mcp-gateway；否则仅 ALLOW_DIRECT_MCP=1 放行
  │  4. zod 校验 tool 参数、语言、大小/数量
  │  5. 本地信任 gateway 已扣（零网络），把 charge_id 透传到结果/错误
  ▼
ImgKits / external_api 翻译上游
  Authorization: Bearer ${UPSTREAM_API_TOKEN}
  Channel: ai
  · a2.imgkits.com     /translate/text
  · api.imgkits.com    /doc-translate/{cost,preview,create,status}
  · ai.imgkits.com     /img-translate/{create,status}
```

Worker 是**无状态**的：不落库、不存调用方 key、不缓存译文。异步 job 状态在上游，MCP 侧用 `job_id` 继续轮询；轮询不会创建新的上游任务。gateway 侧是否对该次 MCP 请求计费以其策略为准。

## 内部头约定（gateway → 本 Worker）

| Header | 必填 | 说明 |
|---|---|---|
| `Authorization: Bearer sk_live_…` | 仅需鉴权方法 | `tools/call` 等执行方法缺失或前缀不是 `sk_live_` → 401。本侧只校验格式，不二次验证真伪、不落盘。 |
| `X-Access-Channel: mcp-gateway` | 仅需鉴权方法 | 有该值即视为经 gateway 的正式路径。缺失时只有 `ALLOW_DIRECT_MCP=1` 才放行。 |
| `X-Mcp-Charge-Id` | 否 | gateway 扣分流水号；本侧透传到工具结果的 `charge.charge_id` 与失败错误里。 |
| `X-Gateway-Shared-Secret` | 配置了才必填（仅需鉴权方法） | 当 Worker 配置了 `GATEWAY_SHARED_SECRET`，值必须恒等匹配，否则 401。 |

公开方法集合：`initialize`、`notifications/initialized`、`notifications/cancelled`、`tools/list`、`ping`（以及其它 `notifications/*`）。这些请求不要求 Bearer、`X-Access-Channel` 或 `X-Gateway-Shared-Secret`；若调用方仍带了 Bearer，会透传给 MCP 上下文。

`/mcp` 的鉴权顺序：

0. 读取并解析 POST body（单个 JSON-RPC 对象或 batch 数组）。若所有方法都属于公开集合，直接交给 MCP handler，不走下面的鉴权；batch 中只要混有 `tools/call` 或未知需鉴权方法，整个请求按需鉴权处理。
1. 解析 `Authorization` Bearer；必须 `sk_live_` 前缀，否则 401。
2. 若 `GATEWAY_SHARED_SECRET` 已配置：`X-Gateway-Shared-Secret` 必须匹配，否则 401。
3. `X-Access-Channel === "mcp-gateway"` → 放行（生产路径）。
4. 否则仅当 `ALLOW_DIRECT_MCP === "1"` 放行（workers.dev 灰度自测）；否则 401，并提示必须经 `https://mcp.imgkits.com/mcp`。
5. Bearer、`X-Mcp-Charge-Id`、`X-Access-Channel` 传入 MCP server / `ToolContext`。

空 body / 非 JSON body 无法识别方法，缺少 Bearer 时仍按现状返回 401；带合法鉴权头时交给 MCP handler 产生协议错误。`OPTIONS` 预检不要求鉴权；CORS allow-headers 已包含 `X-Access-Channel`、`X-Mcp-Charge-Id`、`X-Gateway-Shared-Secret`。

## 工具

| 工具 | 类型 | 默认积分 | 主要限制 | 说明 |
|---|---|---:|---|---|
| `translate_text` | 同步 | 1 | 单次 ≤ 50,000 字符；≤ 50 条 | 上游单条上限 2,000 字符，Worker 自动切到 ≤1,900 字符并拼回 |
| `translate_document` | 异步 | 5 | PDF ≤ 30 MB；其他格式 ≤ 80 MB | 支持 PDF/DOCX/XLSX/PPTX/EPUB/TXT/HTML/MD/CSV/SRT 等；先 cost → preview → create → status |
| `translate_image` | 异步 | 2 | 1–10 张；单张建议 ≤ 10 MB | 公网图片 URL；JPG/PNG/WebP；可设贴合方式与字体 |
| `translate_subtitle` | 同步 | 3 | ≤ 1,000,000 字符 | SRT/VTT/ASS；**时间轴、序号、ASS 事件字段原样保留**，只翻 cue 文本 |
| `detect_language` | 本地 | 0（免费） | ≤ 20,000 字符 | Unicode script + 停用词/变音符启发式；不请求上游、不扣分 |

默认积分在 `wrangler.jsonc` 的 `vars` 里，可按 `COST_*` 调整。工具描述会带上实际配置的 cost。

### 异步 job 与 TTL

- `translate_document` / `translate_image` 默认等 30 秒，可用 `wait_seconds` 调到 0–120 秒。
- 超时未完成会返回 `job_id`；再次调用时**只传 `job_id`** 即可继续轮询，不会创建新的上游任务（本侧也不记录新的扣费；gateway 计费策略以网关为准）。
- 文档工具在上游会先做报价/解析（`cost` + `preview`），再 `create` 启动任务，然后轮询 `status`。
- 上游会清理临时/原始文件；结果 URL 约 24 小时后过期，工具返回 `expires_in_hours: 24`，请立即下载。
- 文档/图片的源文件必须可公网访问（签名 URL 可以）。Worker 不代下载用户文件，避免把任意 URL 变成 Worker 侧 SSRF。

### 字幕为什么不用 `/get-video-vtt/*`

材料里的 `/get-video-vtt/*`、`/get-audio-vtt/*` 是**语音/视频转写**入口，不是字幕翻译。这里用现网稳定的 `/translate/text` 翻译 cue 文本，并由 Worker 重新拼回原时间轴：

- SRT/VTT：保留 index / cue id、时间行、空行结构；只替换 cue 文本。
- ASS/SSA：解析 `[Events]` 的 `Format:`，保留 Layer/Start/End/Style/Name/Margin/Effect 等字段；文本内的 ASS override tag 会被剥离后再翻译，开头 tag 会保留。
- 好处：时间轴绝不会被翻译模型改写。

### 语种检测为什么是本地

材料中 `LanguageDetectorSrv` 只在 TTS 路径内部使用，没有对外公开的 detect 路由。`detect_language` 用本地启发式：

- 非拉丁文字靠 Unicode script 判断（Han/Hiragana/Katakana/Hangul/Cyrillic/Arabic/Devanagari/Thai…）。
- 拉丁语系靠常见停用词 + 变音符打分。
- 返回 `language`、`confidence`、`is_reliable`、`alternatives`。短文本会明确标低置信度。
- 默认 cost=0；如果产品要求收费，把 `COST_DETECT_LANGUAGE` 设为 >0，gateway 会按该成本扣分。

## 扣费与信任模型（挂载 A）

```text
客户端 → gateway：鉴权 + 扣分（402 余额不足 / 503 fail-closed）
       → 本 Worker：校验内部头 → 参数校验 → 本地信任已扣 → 上游调用
       → 返回结果；失败时带 gateway 透传的 charge_id
```

- **本侧没有任何扣分 HTTP 请求**：`src/charge.ts` 不做网络 I/O，也不存在 `/v1/charge` 请求目标。
- `src/tools/common.ts` 的 `billTool()` 调用本地 `chargeCredits()`，根据配置的 cost 与 `ctx.chargeId` 返回 `{ok:true, charged, charge_id?}`。
- `charge_id` 来源是 gateway 的 `X-Mcp-Charge-Id`；没有该头时结果里只有 `charged`，不会伪造流水号。
- 工具在上游失败时，`raiseAfterCharge()` 仍在 `charged > 0` 时附带 charge 信息，便于对账。
- 余额不足、限流、gateway 不可用等错误由 gateway 在转发前返回，本 Worker 不会收到该请求。
- `idempotency_key` 仍是工具可选参数，用于上游 pseudo-user/任务隔离；本侧不再用它做扣分幂等。
- `job_id` 轮询路径完全跳过 `billTool`，本侧不会生成新的扣费记录；gateway 是否计费以网关策略为准。

代码位置：

| 环节 | 文件 |
|---|---|
| 本地“信任 gateway 已扣”助手（零网络） | `src/charge.ts` → `chargeCredits()` |
| 每个工具统一的扣分记录入口 | `src/tools/common.ts` → `billTool()` |
| 文本工具调用点 | `src/tools/translate-text.ts` |
| 文档工具调用点 | `src/tools/translate-document.ts` |
| 图片工具调用点 | `src/tools/translate-image.ts` |
| 字幕工具调用点 | `src/tools/translate-subtitle.ts` |
| 检测工具（默认免费，cost>0 才记录） | `src/tools/detect-language.ts` |

## Secret / 变量

### Secret（不要提交值）

| 名称 | 必填 | 用途 |
|---|---|---|
| `UPSTREAM_API_TOKEN` | 是 | 调 imgkits/external_api 翻译上游的新签 S2S Bearer。禁止复用前端写死密钥。 |
| `GATEWAY_SHARED_SECRET` | 否 | 配了才校验 `X-Gateway-Shared-Secret`；需与 gateway 侧保持一致。 |

调用方的 `sk_live_…` **不落盘**：只在请求内传给工具上下文，不写日志、不进 vars、不进仓。

### Vars（默认值，可在 `wrangler.jsonc` 调整）

| 名称 | 默认值 | 用途 |
|---|---|---|
| `ALLOW_DIRECT_MCP` | `1` | workers.dev 灰度自测：允许不带 `X-Access-Channel` 的直接调用。gateway 接线后改成 `0`。 |
| `TRANSLATE_TEXT_BASE_URL` | `https://a2.imgkits.com` | 文本翻译 |
| `DOC_TRANSLATE_BASE_URL` | `https://api.imgkits.com` | 文档翻译；如现网需走 `ai.imgkits.com` 可改 |
| `IMAGE_TRANSLATE_BASE_URL` | `https://ai.imgkits.com` | 图片翻译 |
| `UPSTREAM_TIMEOUT_MS` | `30000` | 单次上游请求超时 |
| `JOB_POLL_INTERVAL_MS` | `2000` | 文档/图片 job 轮询间隔（最小 200） |
| `COST_TRANSLATE_TEXT` | `1` | 每次文本工具调用的积分 |
| `COST_TRANSLATE_DOCUMENT` | `5` | 每个新文档 job 的积分 |
| `COST_TRANSLATE_IMAGE` | `2` | 每个新图片 job 的积分 |
| `COST_TRANSLATE_SUBTITLE` | `3` | 每次字幕工具调用的积分 |
| `COST_DETECT_LANGUAGE` | `0` | 0 = 免费；>0 时由 gateway 扣分 |

`MCP_CHARGE_BASE_URL`、`MCP_CHARGE_TIMEOUT_MS` 已**废弃并从代码/配置中移除**；本侧不再发任何 charge 请求。

## 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，填入新签的 UPSTREAM_API_TOKEN。不要提交 .dev.vars。
npm run check
npm run dev
```

本地入口：

- 健康检查：<http://127.0.0.1:43201/health>
- MCP：<http://127.0.0.1:43201/mcp>

`initialize`、`tools/list`、`ping` 在任何情况下都无需 Bearer/channel，可直接调 `/mcp` 自测。`tools/call` 需要 Bearer；`wrangler.jsonc` 默认 `ALLOW_DIRECT_MCP=1`，所以本地带 Bearer 即可直连，不需要 gateway。若把该 var 设为 `0`，本地调用 `tools/call` 也必须模拟 gateway 头：

```bash
-H 'x-access-channel: mcp-gateway'
```

`.dev.vars` 只用于 `wrangler dev`，已在 `.gitignore` 中。测试不依赖真实密钥：上游响应在 `test/helpers.ts` 里用全局 `fetch` mock；charge 测试会断言全局 `fetch` **零调用**。

测试覆盖：

- `test/charge.test.ts`：本地 trust 助手、cost 元数据、`charge_id` 透传、0 cost、非法 cost、**无 fetch**。
- `test/upstream.test.ts`：信封解包、文本结果映射、job status 10/-1/-2/0/1/2、长文本切分、`contents` 上限、`channel: ai`、旧公开 path（无 `/api` 前缀）、401/403/404/429/5xx 映射且不回传 token。
- `test/subtitle.test.ts`：SRT/VTT/ASS 解析与时间轴保留。
- `test/languages.test.ts`：语言代码归一化与常见语种检测。
- `test/tools.test.ts`：先记录 gateway charge 再上游、结果带 `charge_id`、job resume 不创建新任务、文档 cost→create→status、图片结果映射、字幕扣一次、无效字幕在请求前被拒、**全程无 `/v1/charge`**。
- `test/worker.test.ts`：health、公开 `initialize`/`tools/list`/`ping` 无鉴权、`tools/call` Bearer/前缀校验、batch 混合方法鉴权、gateway channel、`ALLOW_DIRECT_MCP` 开关、shared secret、CORS preflight、404。
- `test/mcp-smoke.test.ts`：无 Bearer 的 `initialize` / `tools/list` 应 200，无 Bearer 的 `tools/call` 应 401；另跑真实 MCP `initialize` → `tools/list`（5 个工具）→ `tools/call detect_language`。

## 部署（workers.dev 灰度）

```bash
# 1. 登录
npx wrangler login

# 2. 只设置上游 S2S Secret；不要用 echo，避免把换行写进值
npx wrangler secret put UPSTREAM_API_TOKEN

# 3. 可选：如果 gateway 会发送 X-Gateway-Shared-Secret
npx wrangler secret put GATEWAY_SHARED_SECRET

# 4. 校验 + 部署
npm run check
npm run deploy
```

部署后 Wrangler 会打印：

```text
https://mcp-transmonkey.<your-subdomain>.workers.dev
```

本侧 MCP 端点：

```text
https://mcp-transmonkey.<your-subdomain>.workers.dev/mcp
```

**不要**在 `wrangler.jsonc` 里加 `routes` / `custom_domain`。对外域名由 gateway 提供（`https://mcp.imgkits.com/mcp`）；本仓只交付 workers.dev upstream。

### 部署前检查

```bash
npx wrangler deploy --dry-run   # 或 npm run deploy:dry
```

应能看到 `ALLOW_DIRECT_MCP` 等 vars，且 Secret 不出现在 dry-run 列表里。

## 挂载到 gateway

1. 在 gateway 配置 `MCP_TRANSMONKEY_UPSTREAM` = 本 Worker URL（**无尾斜杠**）：
   ```text
   https://mcp-transmonkey.<your-subdomain>.workers.dev
   ```
2. gateway 负责 `POST https://mcp.imgkits.com/v1/charge` 扣分；扣分成功后把 MCP JSON-RPC 转发到 `{MCP_TRANSMONKEY_UPSTREAM}/mcp`，并带：
   - `Authorization: Bearer sk_live_…`（同一把）
   - `X-Access-Channel: mcp-gateway`
   - `X-Mcp-Charge-Id: <扣分流水号>`（建议）
   - 若启用 shared secret：`X-Gateway-Shared-Secret: …`
3. 接线完成后，把本 Worker 的 `ALLOW_DIRECT_MCP` 改为 `"0"`，只保留 gateway 路径。
4. 对客户端只公开 `https://mcp.imgkits.com/mcp`；隐私说明、试用与取 Key 都以 <https://mcp.imgkits.com> 为准。

## 灰度自测

### 1. 健康检查

```bash
curl -sS https://mcp-transmonkey.<subdomain>.workers.dev/health | jq
```

确认：

- `upstream_configured: true`
- `billing: "gateway-only"`
- `direct_mcp_allowed: true`（灰度期；改为 `"0"` 后应为 false）
- `auth_note: "initialize/tools.list/ping public; tools/call requires Bearer"`
- `gateway.required_channel: "mcp-gateway"`
- `gateway.shared_secret_configured` 与是否设置 secret 一致
- 输出里**没有**任何 Secret 值，也没有本侧 charge URL 声明

### 2. 公开发现方法无需 key

```bash
BASE='https://mcp-transmonkey.<subdomain>.workers.dev'

# initialize 期望 200
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$BASE/mcp" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -H "mcp-protocol-version: 2025-06-18" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'

# tools/list 期望 200
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$BASE/mcp" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -H "mcp-protocol-version: 2025-06-18" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

### 3. `tools/call` 未带 key 必须 401

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$BASE/mcp" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -H "mcp-protocol-version: 2025-06-18" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"detect_language","arguments":{"text":"hello"}}}'
# 期望 401
```

### 4. workers.dev 直接自测需鉴权的 `tools/call`（需 `ALLOW_DIRECT_MCP=1`）

```bash
API_KEY='sk_live_...'
BASE='https://mcp-transmonkey.<subdomain>.workers.dev'

curl -sS -N -X POST "$BASE/mcp" \
  -H "authorization: Bearer $API_KEY" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -H "mcp-protocol-version: 2025-06-18" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"detect_language","arguments":{"text":"This is an English sentence."}}}'
```

`initialize` / `tools/list` / `ping` 即使 `ALLOW_DIRECT_MCP=0` 也仍是 200。需要鉴权的 `tools/call` 在 `ALLOW_DIRECT_MCP=0` 时会 401，错误提示必须经 `https://mcp.imgkits.com/mcp`。此时改为带 gateway 头（仅限有权限的内网自测）：

```bash
-H 'x-access-channel: mcp-gateway'
-H 'x-mcp-charge-id: ch_selftest_001'
```

### 5. MCP Inspector

- Transport：`Streamable HTTP`
- 生产 URL：`https://mcp.imgkits.com/mcp`
- workers.dev 自测 URL：`https://mcp-transmonkey.<subdomain>.workers.dev/mcp`
- Header：`Authorization: Bearer sk_live_…`（仅 `tools/call` 等执行方法需要；`initialize` / `tools/list` / `ping` 公开）
- 连接后应能看到 5 个 tool；先调用免费的 `detect_language`，再调用需要积分的工具。

### 6. 免费检测示例

```bash
curl -sS -N -X POST "$BASE/mcp" \
  -H "authorization: Bearer $API_KEY" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -H "mcp-protocol-version: 2025-06-18" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"detect_language","arguments":{"text":"This is an English sentence."}}}'
```

响应可能是 SSE（`event: message` + `data: {...}`），这是正常现象。

## 错误返回

工具错误是 MCP 的 `isError: true`，内容为 JSON：

```json
{
  "ok": false,
  "error": {
    "code": "tool_failed_after_charge",
    "message": "...",
    "details": { "charge_id": "ch_..." }
  }
}
```

常见 code：

| code | 含义 |
|---|---|
| `invalid_arguments` / `invalid_language` / `text_too_long` / `subtitle_too_long` | 参数校验失败，未请求上游 |
| `upstream_not_configured` | Worker 未设置 `UPSTREAM_API_TOKEN`。不打上游 |
| `tool_failed_after_charge` | gateway 已扣（charged>0）但工具/上游业务失败；错误里带 `charge_id`，人工对账 |
| `upstream_job_failed` | 异步 job 失败；若已扣分，错误里带 charge 信息 |
| `upstream_unauthorized` / `upstream_forbidden` / `upstream_not_found` / `upstream_rate_limited` | 上游 HTTP 401 / 403 / 404 / 429。固定文案，不回传响应体，不出现 Authorization 或 token |
| `upstream_unavailable` | 上游 HTTP 5xx |
| `upstream_rejected` / `invalid_upstream_response` / `upstream_http_error` | 其它上游错误。业务拒绝文案会去掉 Bearer / token |
| `unauthorized` | `tools/call` 等需鉴权方法的 Bearer 缺失/前缀错、shared secret 不匹配，或未走 gateway 且直连被禁用（公开发现方法不会触发） |

余额不足（402）、gateway 限流（429）、gateway 不可用（503）由 **gateway 在转发前**返回，不会进入本 Worker 的工具错误。

## 目录

```text
src/
  index.ts                    Worker 入口：health、公开发现方法、tools/call Bearer/gateway 鉴权
  server.ts                   MCP server + 5 个 tool 注册与描述
  config.ts                   URL、超时、限制、默认积分、ALLOW_DIRECT_MCP
  env.ts                      Env / ToolContext 类型（authToken/chargeId/accessChannel）
  charge.ts                   本地“信任 gateway 已扣”助手（零网络，无 /v1/charge）
  upstream.ts                 上游 HTTP、信封解包、job 状态归一化、轮询、长文本切分
  languages.ts                语言代码归一化 + 本地检测
  subtitle.ts                 SRT/VTT/ASS 解析、重建、字幕翻译
  urls.ts                     上游请求前的公网 URL 预检（挡私网/本地/metadata）
  errors.ts                   ToolError / ChargeError / UpstreamError / MCP result
  tools/
    common.ts                 扣分记录、idempotency、语言校验、pseudo userId
    translate-text.ts
    translate-document.ts
    translate-image.ts
    translate-subtitle.ts
    detect-language.ts
test/                         vitest 单测 + MCP smoke
wrangler.jsonc                workers_dev only，无 routes
.dev.vars.example             本地 Secret 模板（不含值）
```

## 安全与硬闸复查

- **业务仓零改动**：本仓只维护自己的文件，未改 `translator` / `usa` / `external_api`。
- **禁复用前端密钥**：上游只认 `UPSTREAM_API_TOKEN` Secret；代码、README、vars 里没有密钥值。
- **本侧零扣分网络**：`src/` 不存在 `fetch` `/v1/charge`；扣分只在 `mcp-credit-gateway`。
- **入口收敛**：`initialize` / `tools/list` / `ping` / `notifications/*` 公开；`tools/call` 等执行方法生产只认 `X-Access-Channel: mcp-gateway`，`ALLOW_DIRECT_MCP` 只用于 workers.dev 灰度，接线后改 `0`。
- **可选二次校验**：配置 `GATEWAY_SHARED_SECRET` 后，需鉴权请求的内部头不匹配直接 401；公开方法不受影响。
- **不存调用方 key**：不写日志、不落 D1/KV；只在请求生命周期内传给工具上下文。
- **workers.dev only**：`wrangler.jsonc` 没有 `routes` / `custom_domain`。
- **SSRF 收敛**：Worker 不下载用户提供的文档/图片/字幕 URL；只把 URL 交给上游。文档/图片 URL 在请求上游前会拒绝 localhost、私网/保留 IP、metadata 主机和带凭据的 URL；上游仍需自己做 egress 控制。字幕只收正文，不收 URL。
- **TTL/大小写进工具描述**：文档/图片的异步 job、大小上限、结果过期时间都写在 MCP tool description 里。

## 当前状态

- 挂载约定 A 已完成：gateway 扣分 + 转发，本侧无 `/v1/charge` 请求；`initialize` / `tools/list` / `ping` / `notifications/*` 已公开，`tools/call` 仍走 Bearer + gateway 鉴权。`npm run check` 全绿，`wrangler deploy --dry-run` 可打包。
- **尚未部署**：本环境没有 Cloudflare 账号/Secret，未执行 `wrangler deploy`。设置 `UPSTREAM_API_TOKEN` 后运行 `npm run deploy`，workers.dev URL 由 Wrangler 输出。
- 未添加 Custom Domain；对外只走 `https://mcp.imgkits.com/mcp`。
