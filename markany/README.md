# mcp-markany

MarkAny 水印能力的独立 Cloudflare Worker + 真 MCP Server（Streamable HTTP）。提供 4 个工具：加水印、去水印、盲水印嵌入、盲水印解析。

- **唯一对外入口**：`https://mcp.imgkits.com/mcp`，由 `mcp-credit-gateway` 鉴权、扣分并转发到本 Worker。
- **挂载约定 A**：**扣分只在 gateway**；本侧**禁止** `fetch` `/v1/charge`，只信任 gateway 已扣并透传 `charge_id`。
- **MCP 传输**：本侧路由 `/mcp`，用 `agents` SDK 的 `createMcpHandler` + `@modelcontextprotocol/server` 的 stateless `McpServer`。
- **鉴权**：`initialize`、`tools/list`、`ping`、`notifications/*` **公开**，不需要 Bearer；只有 `tools/call` 等会执行计费/上游的方法要求 `Authorization: Bearer sk_live_…`。gateway 转发时附 `X-Access-Channel: mcp-gateway`。
- **上游**：统一 `AI_BASE_URL`（默认 `https://ai.imgkits.com`），Worker Secret `UPSTREAM_API_TOKEN` 为新签 S2S Bearer；**不使用任何前端写死密钥**。
- **部署**：仅 `workers_dev: true`，没有 `routes` / `custom_domain`。workers.dev 只作灰度自测。
- **业务仓零改**：未修改 `translator` / `usa` / `external_api`；本仓只维护 Worker 自身文件。
- **隐私 / 取 Key / 余额**：统一看 <https://mcp.imgkits.com>；本 Worker 不签发 key、不存 key。

> ## 版权与滥用硬闸（`remove_watermark`）
>
> **只处理你自有或已获明确授权的素材。禁止用本服务批量剥离他人的版权 / 归属 / 授权水印。**
>
> **硬闸条款：仅处理自有或已获授权素材；禁止批量剥离他人版权水印；调用限频；失败可审计。**
>
> - 调用方必须对源图片拥有版权，或已取得权利人的明确编辑授权。
> - 禁止把本工具用于移除第三方图片的版权水印、图库水印、作者署名或 license 标识，禁止批量、自动化地剥离他人水印。
> - **可执行硬闸**：参数 `confirm_authorization` 默认为 `false`。未显式传 `true` 时 Worker 直接拒绝，**不请求上游**。
> - **按调用方密钥限频**：确认后的调用按 `sk_live_…` 的哈希做滑动窗口，默认 **5 次 / 60 秒**。超限返回工具错误 `rate_limited`，`status` 为 **429**。窗口在单个 Worker isolate 内存中，不落库、不记录原始 key；gateway 侧限频仍然有效。
> - 本工具每次只接受**一张**图片；调用经 `mcp-credit-gateway` 计量，必须持有效 `sk_live_…` key。
> - 每次调用（含拒绝与失败）都会生成 `audit_id` 并写入 Worker 结构化日志；成功结果与拒绝错误都带 `copyright` 字段。滥用可追溯、可审计。
> - 上游/平台可按风控策略拒绝、封禁或上报违规调用。

## 架构（gateway 扣分 + 转发）

```text
MCP 客户端 (Inspector / Claude / 自研 Agent)
  │  Authorization: Bearer sk_live_…
  │  POST https://mcp.imgkits.com/mcp
  ▼
mcp-credit-gateway
  │  1. 校验 sk_live_、扣分、处理 402/503
  │  2. 转发 MCP JSON-RPC 到 MCP_MARKANY_UPSTREAM
  │     X-Access-Channel: mcp-gateway
  │     Authorization: Bearer <同一把 sk_live_…>   (不落盘)
  │     X-Mcp-Charge-Id: <可选，扣分流水号>
  │     X-Gateway-Shared-Secret: <可选，配置了才校验>
  ▼
Cloudflare Worker (本仓，workers.dev)
  │  0. 解析 JSON-RPC：initialize / tools/list / ping / notifications/* 公开
  │     仅当存在 tools/call 或未知需鉴权方法时才继续下面 1–3
  │  1. 校验 Bearer 必须以 sk_live_ 开头
  │  2. 若配置 GATEWAY_SHARED_SECRET，校验 X-Gateway-Shared-Secret
  │  3. 必须有 X-Access-Channel: mcp-gateway；否则仅 ALLOW_DIRECT_MCP=1 放行
  │  4. zod 校验 URL / 水印类型 / 大小 / 页范围 / mask 参数
  │  5. 本地信任 gateway 已扣（零网络），把 charge_id 透传到结果/错误
  ▼
ai.imgkits.com（统一 AI 后端）
  Authorization: Bearer ${UPSTREAM_API_TOKEN}
  Channel: ai
  · POST /index.php?r=ai/encode-blind-watermark        盲水印嵌入
  · POST /index.php?r=ai/decode-blind-watermark        盲水印解析任务
  · GET  /index.php?r=ai/get-decode-blind-watermark    解析结果轮询
  · POST /api/inpaint                                  去水印 / inpaint
  · POST {ADD_WATERMARK_PATH}                           加水印（可配置，默认占位）
```

Worker 是**无状态**的：不落库、不存调用方 key、不缓存图片。异步解析任务状态在上游，MCP 侧用 `job_id` 继续轮询；轮询不会创建新的上游任务。

## 挂载约定 A（gateway → 本 Worker）

| Header | 必填 | 说明 |
|---|---|---|
| `Authorization: Bearer sk_live_…` | 仅需鉴权方法 | `tools/call` 等执行方法缺失或前缀不是 `sk_live_` → 401。本侧只校验格式，不二次验证真伪、不落盘。 |
| `X-Access-Channel: mcp-gateway` | 仅需鉴权方法 | 有该值即视为经 gateway 的正式路径。缺失时只有 `ALLOW_DIRECT_MCP=1` 才放行。 |
| `X-Mcp-Charge-Id` | 否 | gateway 扣分流水号；本侧透传到工具结果的 `charge.charge_id` 与失败错误里。 |
| `X-Gateway-Shared-Secret` | 配置了才必填（仅需鉴权方法） | 当 Worker 配置了 `GATEWAY_SHARED_SECRET`，值必须恒等匹配，否则 401。 |

公开方法集合：`initialize`、`notifications/initialized`、`notifications/cancelled`、`tools/list`、`ping`（以及其它 `notifications/*`）。这些请求不要求 Bearer、`X-Access-Channel` 或 `X-Gateway-Shared-Secret`；若调用方仍带了 Bearer，会透传给 MCP 上下文。

`/mcp` 鉴权顺序：

0. 读取并解析 POST body（单个 JSON-RPC 对象或 batch 数组）。若所有方法都属于公开集合，直接交给 MCP handler，不走下面的鉴权；batch 中只要混有 `tools/call` 或未知需鉴权方法，整个请求按需鉴权处理。
1. 解析 `Authorization` Bearer；必须 `sk_live_` 前缀，否则 401。
2. 若 `GATEWAY_SHARED_SECRET` 已配置：`X-Gateway-Shared-Secret` 必须匹配，否则 401。
3. `X-Access-Channel === "mcp-gateway"` → 放行（生产路径）。
4. 否则仅当 `ALLOW_DIRECT_MCP === "1"` 放行（workers.dev 灰度自测）；否则 401，并提示必须经 `https://mcp.imgkits.com/mcp`。
5. Bearer、`X-Mcp-Charge-Id`、`X-Access-Channel` 传入 MCP server / `ToolContext`。

空 body / 非 JSON body 无法识别方法，缺少 Bearer 时仍返回 401；带合法鉴权头时交给 MCP handler 产生协议错误。`OPTIONS` 预检不要求鉴权；CORS allow-headers 已包含 `X-Access-Channel`、`X-Mcp-Charge-Id`、`X-Gateway-Shared-Secret`。

## 工具

| 工具 | 类型 | 默认积分 | 主要限制 | 上游 |
|---|---|---:|---|---|
| `add_watermark` | 同步 | 2 | 图片 ≤ 10 MB；PDF ≤ 30 MB；文字 ≤ 500 字符；水印图 ≤ 5 MB | `POST {ADD_WATERMARK_PATH}`（默认 `/api/watermark`，占位） |
| `remove_watermark` | 同步 | 3 | 单张图片 ≤ 10 MB；可选 mask URL / 归一化矩形；**版权硬闸** | `POST /api/inpaint` |
| `embed_blind_watermark` | 同步 | 2 | 图片 ≤ 10 MB；嵌入内容 ≤ 512 字符 | `POST /index.php?r=ai/encode-blind-watermark` |
| `decode_blind_watermark` | 异步 | 2 | 等待 0–60 秒；`source_url` 或 `job_id` 二选一 | `POST .../decode-blind-watermark` + `GET .../get-decode-blind-watermark` |

默认积分在 `wrangler.jsonc` 的 `vars` 里，可用 `COST_*` 调整。工具描述会带上实际配置的 cost。

### 1) `add_watermark`

给图片或 PDF 添加**可见**文字 / 图片水印。

| 参数 | 必填 | 说明 |
|---|---|---|
| `source_url` | 是 | 公网 http(s) 图片或 PDF URL |
| `source_type` | 否 | `image` / `pdf`；默认按 `.pdf` 后缀推断 |
| `watermark_type` | 是 | `text` 或 `image` |
| `text` | text 模式必填 | 水印文字，1–500 字符 |
| `watermark_image_url` | image 模式必填 | 公网 PNG/JPG/WebP，≤ 5 MB，支持透明 |
| `position` | 否 | `top-left` / `top-center` / `top-right` / `center` / `bottom-left` / `bottom-center` / `bottom-right` / `tile`，默认 `bottom-right` |
| `opacity` | 否 | 0.05–1，默认 0.35 |
| `scale` | 否 | 图片水印宽度占源图比例，0.02–0.95 |
| `font_size` | 否 | 文字水印字号，8–256 |
| `color` | 否 | `#RRGGBB` |
| `rotation` | 否 | -180–180 度 |
| `pages` | 否 | 仅 PDF：`"1"` / `"1-3"` / `"1-3,5,8-10"` |
| `idempotency_key` | 否 | 调用方关联键，原样回显；扣分仍由 gateway 负责 |

Worker → 上游请求体（`ADD_WATERMARK_PATH` 可被 env 覆盖）：

```json
{
  "source_url": "https://…/source.pdf",
  "source_type": "pdf",
  "type": "text",
  "text": "CONFIDENTIAL",
  "position": "bottom-right",
  "opacity": 0.35,
  "font_size": 48,
  "color": "#ffffff",
  "rotation": 0,
  "pages": "1-3,5"
}
```

`watermark_type=image` 时改为 `"type":"image"` + `"watermark_image":"https://…/logo.png"`，可选 `scale`。
上游响应按 `{success:true,data:{targetUrl}}` 或 `{code:0,data:{url}}` 解包；结果 URL 约 24 小时过期。

> **`ADD_WATERMARK_PATH` 是文档化占位**：参考材料里没有确认的单一现代 REST 路径。默认 `/api/watermark`，部署前请按实际上游确认后用 env 覆盖；单测使用 fixture，不伪造真实 token。

### 2) `remove_watermark`（版权硬闸）

对**单张**图片做 AI 去水印 / inpaint。

| 参数 | 必填 | 说明 |
|---|---|---|
| `source_url` | 是 | 公网 JPG/PNG/WebP，≤ 10 MB；**仅限自有或已获授权素材** |
| `mask_image_url` | 否 | 公网 mask 图；白色/不透明 = 要移除的区域，黑色/透明 = 保留 |
| `mask_rect` | 否 | 归一化矩形 `{x,y,width,height}`，取值 0–1，且 `x+width<=1`、`y+height<=1`；与 `mask_image_url` 互斥 |
| `bucket` | 否 | 上游存储 bucket，默认 `imgkits`（`INPAINT_BUCKET` 可覆盖） |
| `confirm_authorization` | 是（必须为 `true`） | 显式确认自有或已获授权。默认 `false`；省略或 `false` 返回 `authorization_required`，不打上游 |
| `idempotency_key` | 否 | 调用方关联键，原样回显 |

上游 `POST {AI_BASE_URL}/api/inpaint`（AiController::actionEraseperson 同款）：

```json
{ "img": "https://…/source.png", "mask": "https://…/mask.png", "bucket": "imgkits" }
```

- 传 `mask_image_url`：原样作为 `mask` 发送。
- 只传 `mask_rect`：Worker 发 `{"img","bucket","mask_rect":{…}}`。**注意**：`/api/inpaint` 传统上要求 bitmap mask；若上游不支持 `mask_rect`，请改传 `mask_image_url`。README 明确此差异，不假装已确认。
- 两者都不传：走上游自动检测/自动去水印模式（是否支持取决于上游）。
- 一次调用只处理一张图。通过授权确认后，本 Worker 再按调用方密钥限频（默认 5 次 / 60 秒，可用下面的 vars 覆盖，**不是定价**）。超限不打上游。
- 每次调用返回 `audit_id`，成功、拒绝与失败都会写结构化日志，便于审计。日志不含 key、token 或完整 URL。
- 成功结果的 `copyright` 字段保持不变；授权拒绝和限频拒绝的 `error.details.copyright` 也带同一段声明。该声明也出现在 MCP tool description 和本 README。

### 3) `embed_blind_watermark`

把不可见盲水印嵌入图片，走 AiController `EncodeBlindWatermark` / 阿里云 IMM 路径。

| 参数 | 必填 | 说明 |
|---|---|---|
| `source_url` | 是 | 公网 JPG/PNG/WebP/BMP，≤ 10 MB；建议 ≥ 64×64 |
| `watermark_text` | 否 | 要嵌入的内容，≤ 512 字符（如订单号 / 用户 ID） |
| `model` | 否 | `DWT`（默认，抗缩放更好）或 `DCT` |
| `strength` | 否 | 1–10 |
| `idempotency_key` | 否 | 调用方关联键，原样回显 |

**服务端持钥**：若调用方省略 `watermark_text`，Worker 使用 Secret `BLIND_WATERMARK_KEY` 作为嵌入内容（未配置则报 `watermark_content_missing`）。无论内容来自调用方还是 Secret，**结果都不会回显水印内容**，只返回 `watermark_source` 与 `watermark_chars`。

上游请求体按 AiController 的 `payload` / `SourceURI` 结构：

```json
{
  "payload": {
    "SourceURI": "https://…/source.png",
    "Content": "order-123",
    "Model": "DWT",
    "Strength": 4
  }
}
```

上游响应 `{success:true,data:{targetUrl}}`；若只返回 `RequestId`，结果里会带 `request_id`，`target_url` 可能为 null。结果 URL 约 24 小时过期。

### 4) `decode_blind_watermark`

解析图片中的盲水印，走 `CreateDecodeBlindWatermarkTask` + `GetDecodeBlindWatermarkResult` 异步路径。

| 参数 | 必填 | 说明 |
|---|---|---|
| `source_url` | 二选一 | 公网图片 URL，创建新解析任务 |
| `job_id` | 二选一 | 上次返回的上游 task id，仅轮询，不创建新任务 |
| `wait_seconds` | 否 | 0–60 秒，默认 15；超时返回 `job_id` 供继续轮询 |
| `idempotency_key` | 否 | 调用方关联键，原样回显 |

流程：

```text
POST {AI_BASE_URL}/index.php?r=ai/decode-blind-watermark   {"url": "https://…/image.png"}
  → {success:true,data:{taskId:"…"}}
GET  {AI_BASE_URL}/index.php?r=ai/get-decode-blind-watermark&taskId=…
  → {success:true,data:{Status,Code,Message,Content,UserData}}
```

状态归一化：`Success/Done` → `done`；`Failed/Error/Expired` → `failed`；其余 → `pending`。失败会抛 `upstream_job_failed`（已扣分时再包装成 `tool_failed_after_charge`，带 `charge_id`）。超时返回 `state:"pending"`、`timed_out:true` 和 `retry.arguments.job_id`。

轮询不会创建新的上游任务；是否对轮询请求计费以 `mcp-credit-gateway` 的策略为准，本侧只按 `COST_DECODE_BLIND_WATERMARK` 声明 cost 元数据。

## 成本元数据（gateway 扣分用，本侧只声明）

| 工具 | 默认 cost | Env 覆盖 |
|---|---:|---|
| `add_watermark` | 2 | `COST_ADD_WATERMARK` |
| `remove_watermark` | 3 | `COST_REMOVE_WATERMARK` |
| `embed_blind_watermark` | 2 | `COST_EMBED_BLIND_WATERMARK` |
| `decode_blind_watermark` | 2 | `COST_DECODE_BLIND_WATERMARK` |

- **本侧没有任何扣分 HTTP 请求**：`src/charge.ts` 零网络 I/O，`src/tools/common.ts` 的 `billTool()` 只返回 `{ok:true, charged, charge_id?}`。
- `charge_id` 来源是 gateway 的 `X-Mcp-Charge-Id`；没有该头时只返回 `charged`，不伪造流水号。
- 上游失败时 `raiseAfterCharge()` 在 `charged>0` 时附带 charge 信息，便于对账。
- 余额不足（402）、gateway 限流（429）、gateway 不可用（503）由 gateway 在转发前返回，本 Worker 不会收到该请求。

## Secret / 变量

### Secret（不要提交值）

| 名称 | 必填 | 用途 |
|---|---|---|
| `UPSTREAM_API_TOKEN` | 是 | 调 `ai.imgkits.com` 的新签 S2S Bearer。占位值 `replace-with-a-new-s2s-token`；禁止复用前端写死密钥。 |
| `GATEWAY_SHARED_SECRET` | 否 | 配了才校验 `X-Gateway-Shared-Secret`；需与 gateway 侧一致。 |
| `BLIND_WATERMARK_KEY` | 否 | 服务端持有的盲水印内容/密钥；配置后 `embed_blind_watermark` 可省略 `watermark_text`。永不回显、不写日志。 |

调用方的 `sk_live_…` **不落盘**：只在请求内传给工具上下文，不写日志、不进 vars、不进仓。

### Vars（默认值，可在 `wrangler.jsonc` 调整）

| 名称 | 默认值 | 用途 |
|---|---|---|
| `ALLOW_DIRECT_MCP` | `1` | workers.dev 灰度自测：允许不带 `X-Access-Channel` 的直接调用。gateway 接线后改成 `0`。 |
| `AI_BASE_URL` | `https://ai.imgkits.com` | 统一 AI 上游基址 |
| `ADD_WATERMARK_PATH` | `/api/watermark` | 加水印路径（**占位**，按上游确认后覆盖） |
| `REMOVE_WATERMARK_PATH` | `/api/inpaint` | 去水印路径 |
| `BLIND_ENCODE_PATH` | `/index.php?r=ai/encode-blind-watermark` | 盲水印嵌入 |
| `BLIND_DECODE_PATH` | `/index.php?r=ai/decode-blind-watermark` | 盲水印解析任务创建 |
| `BLIND_RESULT_PATH` | `/index.php?r=ai/get-decode-blind-watermark` | 盲水印解析结果 |
| `INPAINT_BUCKET` | `imgkits` | inpaint 结果 bucket |
| `UPSTREAM_TIMEOUT_MS` | `30000` | 单次上游请求超时 |
| `JOB_POLL_INTERVAL_MS` | `2000` | 解析任务轮询间隔（最小 200） |
| `COST_*` | 见上表 | 各工具默认积分。本批不改任何定价数字 |
| `REMOVE_WATERMARK_RATE_LIMIT` | `5` | 可选。每个调用方密钥在窗口内允许的已确认 `remove_watermark` 次数。代码默认 5；小于 1 时按 1 |
| `REMOVE_WATERMARK_RATE_WINDOW_MS` | `60000` | 可选。滑动窗口毫秒数。代码默认 60000；小于 1000 时按 1000 |

所有上游请求都会带 `Authorization: Bearer ${UPSTREAM_API_TOKEN}`（即使上游暂未校验，也保留头以便新签后启用）。

## 上游材料与推定

| 能力 | 材料 | 本仓端点 |
|---|---|---|
| 盲水印嵌入 | `/workspace/tmp/usa/php-yii2/producter/frontend/controllers/AiController.php` → `actionEncodeBlindWatermark` | `POST /index.php?r=ai/encode-blind-watermark` |
| 盲水印解析 | 同上 → `actionDecodeBlindWatermark` / `actionGetDecodeBlindWatermark` | `POST .../decode-blind-watermark` + `GET .../get-decode-blind-watermark` |
| 阿里云 IMM 调用 | `/workspace/tmp/usa/php-yii2/producter/common/services/AliCloudService.php`（`EncodeBlindWatermark` / `CreateDecodeBlindWatermarkTask` / `GetDecodeBlindWatermarkResult`，host `imm.cn-shanghai.aliyuncs.com`） | 由 `ai.imgkits.com` 代理 |
| 去水印 / inpaint | `AiController::actionEraseperson` → `POST http://ai.imgkits.com/api/inpaint` | `POST /api/inpaint` |
| 加水印 | 材料中没有确认的单一现代 REST | `ADD_WATERMARK_PATH` 可配置，默认占位 |

`ai.imgkits.com` 的响应可能是 `{success,message,data}`（AiController `Common::respJson`）或 `{code,msg,data}`（ImgKits 风格）；`src/upstream.ts` 两种都解包。**不要编造真实 token**；`.dev.vars.example` 只有占位值。

## 本地开发

```bash
npm ci
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，填入新签的 UPSTREAM_API_TOKEN。不要提交 .dev.vars。
npm run check
npm run dev
```

本地入口：

- 健康检查：<http://127.0.0.1:43201/health>
- MCP：<http://127.0.0.1:43201/mcp>

`initialize`、`tools/list`、`ping` 在任何情况下都无需 Bearer/channel，可直接调 `/mcp` 自测。`tools/call` 需要 Bearer；`wrangler.jsonc` 默认 `ALLOW_DIRECT_MCP=1`，所以本地带 Bearer 即可直连。若把该 var 设为 `0`，本地调用 `tools/call` 也必须模拟 gateway 头 `-H 'x-access-channel: mcp-gateway'`。

`.dev.vars` 只用于 `wrangler dev`，已在 `.gitignore` 中。测试不依赖真实密钥：上游响应在 `test/helpers.ts` 里用全局 `fetch` mock；charge 测试断言零 `fetch`。

测试覆盖：

- `test/charge.test.ts`：本地 trust 助手、cost 元数据、`charge_id` 透传、0 cost、非法 cost。
- `test/upstream.test.ts`：两种上游信封、结果 URL/taskId 提取、盲水印状态归一化、轮询超时、`withQuery`、Bearer/`channel: ai` 头、401/403/404/429/5xx 映射且不回传 token。
- `test/urls.test.ts`：公网 URL 预检（私网/保留 IP、metadata、数字主机、带凭据 URL）。
- `test/watermark-tools.test.ts`：4 个工具的参数校验、上游 body/schema、`ADD_WATERMARK_PATH` 覆盖、mask 三种模式、服务端盲水印钥不回显、异步 job 轮询、失败审计/charge 包装、`confirm_authorization` 未确认拒绝、按密钥 429 限频、缺 token 不打上游、**全程无 `/v1/charge`**。
- `test/rate-limit.test.ts`：默认 5 次/60 秒、窗口过期、调用方 key 只存哈希。
- `test/worker.test.ts`：health、公开 `initialize`/`tools/list`/`ping`、`tools/call` Bearer/前缀校验、batch 混合方法鉴权、gateway channel、`ALLOW_DIRECT_MCP` 开关、shared secret、CORS preflight、404。
- `test/mcp-smoke.test.ts`：无 Bearer 的 `initialize` / `tools/list` 应 200，无 Bearer 的 `tools/call` 应 401；真实 MCP `initialize` → `tools/list`（4 个工具）→ `tools/call add_watermark`。

## 部署（workers.dev 灰度）

> 本仓交付时**未执行 deploy**。部署由负责人手动完成。

```bash
# 1. 登录
npx wrangler login

# 2. 只设置上游 S2S Secret；不要用 echo，避免把换行写进值
npx wrangler secret put UPSTREAM_API_TOKEN

# 3. 可选：服务端盲水印内容 / gateway shared secret
npx wrangler secret put BLIND_WATERMARK_KEY
npx wrangler secret put GATEWAY_SHARED_SECRET

# 4. 校验 + 部署
npm ci
npm run check
npm run deploy:dry
npm run deploy
```

部署后 Wrangler 会打印：

```text
https://mcp-markany.<your-subdomain>.workers.dev
```

本侧 MCP 端点：

```text
https://mcp-markany.<your-subdomain>.workers.dev/mcp
```

**不要**在 `wrangler.jsonc` 里加 `routes` / `custom_domain`。对外域名由 gateway 提供（`https://mcp.imgkits.com/mcp`）；本仓只交付 workers.dev upstream。

部署前确认：

- `AI_BASE_URL` / `ADD_WATERMARK_PATH` 与实际上游一致（`ADD_WATERMARK_PATH` 默认是占位）。
- `UPSTREAM_API_TOKEN` 是新签 S2S token，不是前端 key。
- `ALLOW_DIRECT_MCP` 灰度期为 `1`，gateway 接线后改 `0`。
- `npm run deploy:dry` 能看到 vars，且 Secret 不出现在 dry-run 列表里。

## 挂载到 gateway

1. 在 gateway 配置 `MCP_MARKANY_UPSTREAM` = 本 Worker URL（**无尾斜杠**）：
   ```text
   https://mcp-markany.<your-subdomain>.workers.dev
   ```
2. gateway 负责 `POST https://mcp.imgkits.com/v1/charge` 扣分；扣分成功后把 MCP JSON-RPC 转发到 `{MCP_MARKANY_UPSTREAM}/mcp`，并带：
   - `Authorization: Bearer sk_live_…`（同一把）
   - `X-Access-Channel: mcp-gateway`
   - `X-Mcp-Charge-Id: <扣分流水号>`（建议）
   - 若启用 shared secret：`X-Gateway-Shared-Secret: …`
3. 接线完成后，把本 Worker 的 `ALLOW_DIRECT_MCP` 改为 `"0"`。
4. 对客户端只公开 `https://mcp.imgkits.com/mcp`；隐私说明、试用与取 Key 都以 <https://mcp.imgkits.com> 为准。

## 灰度自测

脱敏 curl 样例见 [`evidence/curl-samples.md`](evidence/curl-samples.md)。以下 `<subdomain>` / `sk_live_...` 均为占位。

### 1. 健康检查

```bash
curl -sS https://mcp-markany.<subdomain>.workers.dev/health | jq
```

确认：

- `service: "mcp-markany"`
- `upstream_configured: true`
- `billing: "gateway-only"`
- `direct_mcp_allowed: true`（灰度期；改为 `"0"` 后应为 false）
- `auth_note: "initialize/tools.list/ping public; tools/call requires Bearer"`
- `gateway.required_channel: "mcp-gateway"`
- `privacy` / `api_keys` 均为 `https://mcp.imgkits.com`
- `copyright_policy` 含“仅自有/已授权素材”声明
- 输出里**没有**任何 Secret 值，也没有本侧 charge URL 声明

### 2. 公开发现方法无需 key

```bash
BASE='https://mcp-markany.<subdomain>.workers.dev'

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
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"add_watermark","arguments":{"source_url":"https://assets.imgkits.com/demo/source.png","watermark_type":"text","text":"demo"}}}'
# 期望 401
```

### 4. workers.dev 直接自测 `tools/call`（需 `ALLOW_DIRECT_MCP=1`）

```bash
API_KEY='sk_live_...'
BASE='https://mcp-markany.<subdomain>.workers.dev'

curl -sS -N -X POST "$BASE/mcp" \
  -H "authorization: Bearer $API_KEY" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -H "mcp-protocol-version: 2025-06-18" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"add_watermark","arguments":{"source_url":"https://assets.imgkits.com/demo/source.png","watermark_type":"text","text":"CONFIDENTIAL","position":"bottom-right","opacity":0.35}}}'
```

`initialize` / `tools/list` / `ping` 即使 `ALLOW_DIRECT_MCP=0` 也仍是 200。需要鉴权的 `tools/call` 在 `ALLOW_DIRECT_MCP=0` 时会 401，错误提示必须经 `https://mcp.imgkits.com/mcp`。此时改为带 gateway 头（仅限有权限的内网自测）：

```bash
-H 'x-access-channel: mcp-gateway'
-H 'x-mcp-charge-id: ch_selftest_001'
```

### 5. MCP Inspector

- Transport：`Streamable HTTP`
- 生产 URL：`https://mcp.imgkits.com/mcp`
- workers.dev 自测 URL：`https://mcp-markany.<subdomain>.workers.dev/mcp`
- Header：`Authorization: Bearer sk_live_…`（仅 `tools/call` 等执行方法需要；`initialize` / `tools/list` / `ping` 公开）
- 连接后应能看到 4 个 tool；可先用一个自有素材测试 `add_watermark` / `embed_blind_watermark`，再测试 `decode_blind_watermark`。

### 6. 去水印自测（仅自有/已授权素材）

```bash
curl -sS -N -X POST "$BASE/mcp" \
  -H "authorization: Bearer $API_KEY" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -H "mcp-protocol-version: 2025-06-18" \
  -d '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"remove_watermark","arguments":{"source_url":"https://assets.imgkits.com/demo/own-image.png","confirm_authorization":true,"mask_rect":{"x":0.6,"y":0.8,"width":0.3,"height":0.15}}}}'
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
| `invalid_arguments` / `invalid_url` / `blocked_url` / `invalid_page_range` / `invalid_job_id` / `text_too_long` | 参数校验失败，未请求上游 |
| `authorization_required` | `remove_watermark` 未把 `confirm_authorization` 设为 `true`。不打上游，`details.copyright` 仍在 |
| `rate_limited`（`status: 429`） | 该调用方密钥在滑动窗口内超过默认 5 次/60 秒。不打上游 |
| `watermark_content_missing` / `server_key_invalid` | 盲水印内容缺失或 `BLIND_WATERMARK_KEY` 非法 |
| `upstream_not_configured` | Worker 未设置 `UPSTREAM_API_TOKEN`。不打上游 |
| `tool_failed_after_charge` | gateway 已扣（charged>0）但工具/上游业务失败；错误里带 `charge_id`，人工对账 |
| `upstream_job_failed` | 异步解析任务失败；若已扣分，错误里带 charge 信息与 `audit_id` |
| `upstream_unauthorized` / `upstream_forbidden` / `upstream_not_found` / `upstream_rate_limited` | 上游 HTTP 401 / 403 / 404 / 429。消息是固定文案，不回传响应体 |
| `upstream_unavailable` | 上游 HTTP 5xx |
| `upstream_rejected` / `invalid_upstream_response` / `upstream_http_error` | 其它上游错误。业务拒绝文案会去掉 Bearer / token |
| `unauthorized` | `tools/call` 等需鉴权方法的 Bearer 缺失/前缀错、shared secret 不匹配，或未走 gateway 且直连被禁用 |

余额不足（402）、gateway 限流（429）、gateway 不可用（503）由 **gateway 在转发前**返回，不会进入本 Worker 的工具错误。

## 目录

```text
src/
  index.ts                         Worker 入口：health、公开发现方法、tools/call Bearer/gateway 鉴权
  server.ts                        MCP server + 4 个 watermark tool 注册与描述
  config.ts                        AI 基址/路径、限制、默认积分、版权声明、ALLOW_DIRECT_MCP
  env.ts                           Env / ToolContext 类型（authToken/chargeId/accessChannel/blind key）
  charge.ts                        本地“信任 gateway 已扣”助手（零网络，无 /v1/charge）
  upstream.ts                      上游 HTTP、两种信封解包、盲水印状态归一化、job 轮询、HTTP 错误映射
  rate-limit.ts                    remove_watermark 按调用方密钥的滑动窗口（默认 5 次/60 秒）
  urls.ts                          上游请求前的公网 URL 预检（挡私网/本地/metadata）
  errors.ts                        ToolError / ChargeError / UpstreamError / MCP result
  tools/
    common.ts                      扣分信任、idempotency、audit id / 结构化日志
    add-watermark.ts               可见文字/图片水印（图片 + PDF 页范围）
    remove-watermark.ts            去水印（mask URL / mask 矩形 / auto）+ 版权硬闸
    embed-blind-watermark.ts       盲水印嵌入（服务端持钥）
    decode-blind-watermark.ts      盲水印解析（异步 job_id 轮询）
test/                              vitest 单测 + MCP smoke
evidence/curl-samples.md           脱敏 curl 样例
wrangler.jsonc                     workers_dev only，无 routes
.dev.vars.example                  本地 Secret 模板（不含值）
```

## 安全与硬闸复查

- **业务仓零改动**：本仓只维护自己的文件，未改 `translator` / `usa` / `external_api`。
- **禁复用前端密钥**：上游只认 `UPSTREAM_API_TOKEN` / `BLIND_WATERMARK_KEY` Secret；代码、README、vars 里没有真实密钥值。
- **本侧零扣分网络**：`src/` 不存在 `fetch` `/v1/charge`；扣分只在 `mcp-credit-gateway`。
- **入口收敛**：`initialize` / `tools/list` / `ping` / `notifications/*` 公开；`tools/call` 等执行方法生产只认 `X-Access-Channel: mcp-gateway`，`ALLOW_DIRECT_MCP` 只用于 workers.dev 灰度，接线后改 `0`。
- **可选二次校验**：配置 `GATEWAY_SHARED_SECRET` 后，需鉴权请求的内部头不匹配直接 401；公开方法不受影响。
- **不存调用方 key**：不写日志、不落 D1/KV；只在请求生命周期内传给工具上下文。
- **workers.dev only**：`wrangler.jsonc` 没有 `routes` / `custom_domain`。
- **SSRF 收敛**：Worker 不下载用户图片/PDF；只把 URL 交给上游。`source_url` / `watermark_image_url` / `mask_image_url` 在请求上游前会拒绝 localhost、私网/保留 IP、metadata 主机、非 http(s) 和带凭据的 URL；上游仍需自己做 egress 控制。
- **去水印版权硬闸**：`confirm_authorization` 默认 false，未确认直接拒；每个调用方密钥滑动窗口默认 5 次/60 秒，超限 `rate_limited` / 429；tool description、README、成功结果的 `copyright` 以及拒绝错误的 `details.copyright` 都包含“仅自有/已授权素材、禁止批量剥离他人版权水印、限频、失败可审计”声明。
- **审计**：每次工具调用生成 `audit_id`；`remove_watermark` 成功/失败均写结构化日志（tool、audit_id、charge_id、source host、mask mode、outcome），不记录 key、水印内容或完整 URL。
- **盲水印内容不回显**：`embed_blind_watermark` 只返回 `watermark_source` / `watermark_chars`，不返回 `watermark_text` 或 `BLIND_WATERMARK_KEY`。
- **大小写进工具描述**：图片/PDF/水印图上限、正文长度、等待秒数都写在 MCP tool description 里。

## 当前状态

- 已从 `mcp-transmonkey` 翻译模板改写为 `mcp-markany`：删除翻译/字幕/语种检测代码，保留挂载 A 与公开 `initialize` / `tools/list` / `ping` 鉴权模式。
- 4 个工具、成本元数据、版权硬闸、workers.dev 部署说明、隐私链 `https://mcp.imgkits.com` 均已落地。
- `npm test` 全绿（80 tests）。定价数字与上游 path 未改。
- **尚未部署、未 git commit**：部署由负责人执行；本环境不执行 `wrangler deploy`。
- `ADD_WATERMARK_PATH` 仍为文档化占位 `/api/watermark`，需按实际上游确认后覆盖。
