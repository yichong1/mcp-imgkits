# mcp-imgkits-core

ImgKits 核心图片能力的独立 Cloudflare Worker + 真 MCP Server（Streamable HTTP）。

- **Worker 名**：`mcp-imgkits-core`
- **唯一对外入口**：`https://mcp.imgkits.com/mcp`，由 `mcp-credit-gateway` 鉴权、扣分并转发到本 Worker。
- **本侧路由**：只有 `/mcp`。没有 `/api/mcp/*`，也没有其它 path 别名。
- **挂载约定 A**：扣分只在 gateway。本侧 `chargeCredits` 只做本地记账，**零网络**，不 `fetch` `/v1/charge`。非直连时期望 `X-Access-Channel: mcp-gateway` 与可选 `X-Mcp-Charge-Id`。
- **鉴权**：`initialize`、`tools/list`、`ping`、`notifications/*` 公开。`tools/call` 要求 `Authorization: Bearer sk_live_…`。
- **上游**：公开接口，**不带 Bearer**。不要配置前端密钥，也不要设 `UPSTREAM_API_TOKEN`。
- **部署**：`workers_dev: true`，没有 `routes` / `custom_domain`。workers.dev 只作灰度自测。
- **业务仓零改**：不改 `imgkits` / `usa` / `translator` / `markany-ai`。本目录只维护这个 Worker。
- **隐私 / 取 Key / 余额**：<https://mcp.imgkits.com>。本 Worker 不签发 key、不存 key。

## 工具

| 工具 | `tools/list` | 默认积分 | 上游 |
|---|---|---:|---|
| `colorize_photo` | 是 | 2 | `POST https://ai.imgkits.com/api/deoldify` body `{img}` |
| `upscale_image` | 是 | 2 | `POST https://ai.imgkits.com/api/restoration` body `{img, upscale}`，可选 `face_enhance` / `bucket` |
| `remove_background` | 是 | 2 | `GET https://usa.imgkits.com/ai/segment?pic=`；subject 换成 `/ai/segmenthead\|cloth\|commodity\|animal\|logo\|body\|furniture` |
| `cartoonize` | 是 | 2 | 默认 `POST https://api.imgkits.com/api/cartoonize` body `{img}`；`style` 或 `variant` 改打 `/api/cartoonize/v2` |
| `extend_image` | 是 | 2 | `POST https://usa.imgkits.com/ai/image-outpainting` body `{pic, ratio}` |
| `resize_image` | 是 | 1 | `GET https://usa.imgkits.com/ai/change-img-size?pic&width&height` |
| `compress_image` | 是 | 1 | **无上游**。Worker 内缩放/重编码 |
| `erase_object` | **否** | 不扣 | 壳。不调用 `POST https://ai.imgkits.com/api/inpaint` |

没有 `enhance_photo` / `enhance_face`。脸部增强和倍率都在 `upscale_image` 上。

`erase_object` 不在 `tools/list`，`/health` 的 `tools` 里也没有它。`/api/inpaint` 经常返回 HTTP 500 HTML，列出来会被 gateway 当成可调用工具去扣分。直接 `tools/call erase_object` 会得到未知工具错误；代码里的 stub 即使被调用也不会发请求、也不会记一笔 charge。

默认积分在 `wrangler.jsonc` 的 `COST_*`，可覆盖。工具描述会带上实际 cost。本侧 cost 只是元数据；真正扣分在 gateway。

### 请求形状（2026-11-05 对公开上游的核对）

这些调用没有带 Authorization。

- 上色：`POST /api/deoldify` `{"img":"<url>"}` → `{"url":"https://..."}`。过小或无法上色时可能 `{"url":null}`，本侧当成失败，不返回成功。
- 超分：`POST /api/restoration` `{"img":"<url>","upscale":2}` → `{"url":"https://..."}`。`upscale:4` 与网站超分一致。带 `face_enhance: true` 的探测同样返回了结果 URL；网站前端本身只发 `{img, bucket, upscale:4}`，所以脸部字段是原样转发，不另开工具。
- 去背：`GET /ai/segment?pic=<url>` → `{success:true,data:{urls:[{url}]}}`。
- 卡通：`POST /api/cartoonize` `{"img":"<url>"}` → `{"url":"https://..."}`。`style` 或 `variant` 改为 `POST /api/cartoonize/v2`，body 里带上对应字段。
- 扩图：`POST /ai/image-outpainting` `{"pic":"<url>","ratio":"16:9"}`。比例和原图一样时上游会拒绝。
- 改尺寸：必须用 GET `?pic&width&height`。对这个 path 发 JSON POST 会 500。
- 压缩：不访问上述主机。

结果 URL 大约 24 小时过期，响应里的 `expires_in_hours` 是这个提示，不是本 Worker 的存储。

## compress_image 限制

纯 Worker，没有对象存储，结果是 `image_base64`，没有 `result_url`。

| 项 | 限制 |
|---|---|
| 输入 | 直接 http(s) 图片 URL，最大 8 MB。3xx 重定向直接拒绝（避免跳到内网） |
| 输出 | 最大 1.5 MB。更大则失败，请降低 `quality` 或 `max_width` / `max_height` |
| 缩放 | 只缩小（`fit: scale-down`），不放大 |
| 质量 | `quality` 1–100，默认 75。PNG 基本忽略 quality |
| 格式 | `jpeg`（默认）/ `webp` / `png` |
| 编码 | 优先 Cloudflare Images binding `IMAGES`。没有 binding 时退回 Workers `fetch` 的 `cf.image`（账号需开通图片转换，否则失败） |
| 动图 | 可能被压成静帧 |
| 计费时机 | 先下载并检查类型/大小，不合规则在本地记账前失败。编码失败且 cost>0 时错误里带 `charge_id` |

`/health` 的 `compress.images_binding` 表示当前进程有没有 `IMAGES`。

## 架构

```text
MCP 客户端
  │  Authorization: Bearer sk_live_…
  │  POST https://mcp.imgkits.com/mcp
  ▼
mcp-credit-gateway          ← 扣分发生在这里（本 PR 不改 gateway 仓库）
  │  X-Access-Channel: mcp-gateway
  │  X-Mcp-Charge-Id: <可选>
  │  Service Binding IMGKITS_CORE_MCP
  ▼
Worker mcp-imgkits-core  /mcp
  │  公开方法直接进 MCP
  │  tools/call：sk_live_ → 可选 shared secret → channel 或 ALLOW_DIRECT_MCP=1
  │  chargeCredits() 本地信任已扣，零网络
  ▼
ai.imgkits.com / api.imgkits.com / usa.imgkits.com
  无 Authorization
```

Worker 无状态：不落库、不存调用方 key、不缓存图片。

## 挂载到 gateway（只文档，本 PR 不改 gateway）

`mcp-credit-gateway` 接上这个 Worker 时需要：

| 项 | 值 |
|---|---|
| Service Binding | `IMGKITS_CORE_MCP` → Worker `mcp-imgkits-core` |
| 开关 var | `MCP_IMGKITS_CORE_UPSTREAM` = `https://mcp-imgkits-core.<subdomain>.workers.dev`（无尾斜杠） |

Cloudflare 禁止 Worker 经公网互打 `*.workers.dev`（错误码 1042）。生产转发必须走 Service Binding。`MCP_IMGKITS_CORE_UPSTREAM` 作开关和文档基址，binding 负责实际 `fetch`。

转发 `tools/call` 时带上：

- `Authorization: Bearer sk_live_…`（同一把，不落盘）
- `X-Access-Channel: mcp-gateway`
- `X-Mcp-Charge-Id: <扣分流水号>`（建议）
- 若两边都配置了 shared secret：`X-Gateway-Shared-Secret`

建议 gateway 按本侧默认积分扣：`colorize_photo=2`、`upscale_image=2`、`remove_background=2`、`cartoonize=2`、`extend_image=2`、`resize_image=1`、`compress_image=1`。可用本 Worker 的 `COST_*` 覆盖本地元数据，但扣分数字以 gateway 为准。

**不要**把 `erase_object` 配进可调用/可导航列表，除非它重新出现在 `tools/list`。现在它不在列表里。

接线完成后把本 Worker 的 `ALLOW_DIRECT_MCP` 改成 `"0"`。对客户端只公开 `https://mcp.imgkits.com/mcp`。

## 鉴权顺序（`/mcp`）

公开方法：`initialize`、`notifications/initialized`、`notifications/cancelled`、`tools/list`、`ping`，以及其它 `notifications/*`。

0. POST body 全是公开方法 → 不要求 Bearer / channel / shared secret。
1. Bearer 必须以 `sk_live_` 开头，否则 401。
2. 配置了 `GATEWAY_SHARED_SECRET` 时，`X-Gateway-Shared-Secret` 必须相等，否则 401。
3. `X-Access-Channel: mcp-gateway` → 放行。
4. 否则只有 `ALLOW_DIRECT_MCP=1` 放行；不然 401，并提示走 `https://mcp.imgkits.com/mcp`。

`OPTIONS` 预检不鉴权。CORS 允许 `X-Access-Channel`、`X-Mcp-Charge-Id`、`X-Gateway-Shared-Secret`。

## Secret / 变量

公开上游不需要 Secret。可选：

```bash
npx wrangler secret put GATEWAY_SHARED_SECRET
```

只有 gateway 也会发 `X-Gateway-Shared-Secret` 时才设。不要把前端 key 写进 vars、`.dev.vars` 或代码。

| Var | 默认 | 用途 |
|---|---|---|
| `ALLOW_DIRECT_MCP` | `1` | 灰度直连。接线后改 `0` |
| `AI_BASE_URL` | `https://ai.imgkits.com` | 上色、超分 |
| `API_BASE_URL` | `https://api.imgkits.com` | 卡通 |
| `USA_BASE_URL` | `https://usa.imgkits.com` | 去背、扩图、改尺寸 |
| `COLORIZE_PATH` | `/api/deoldify` | |
| `UPSCALE_PATH` | `/api/restoration` | |
| `CARTOONIZE_PATH` | `/api/cartoonize` | v1 |
| `CARTOONIZE_V2_PATH` | `/api/cartoonize/v2` | 有 style/variant 时 |
| `SEGMENT_PATH` | `/ai/segment` | subject=general |
| `OUTPAINT_PATH` | `/ai/image-outpainting` | |
| `RESIZE_PATH` | `/ai/change-img-size` | |
| `ERASE_PATH` | `/api/inpaint` | 只写在隐藏 stub 的错误文案里，不会请求 |
| `RESTORATION_BUCKET` | 空 | 设了才放进超分 body |
| `UPSTREAM_TIMEOUT_MS` | `45000` | 单次上游超时 |
| `COST_*` | 见上表 | 本地积分元数据 |

## 本地

```bash
cd imgkits-core
npm ci
npm run check
npm run dev
```

- 健康检查：<http://127.0.0.1:43202/health>
- MCP：<http://127.0.0.1:43202/mcp>

`npm run dev` 默认 `ALLOW_DIRECT_MCP=1`，`tools/call` 带 `sk_live_` 即可。改成 `0` 后必须加 `X-Access-Channel: mcp-gateway`。

测试用 mock `fetch`，不打真实上游、不需要密钥。`charge` 测试断言没有 `fetch`。

## 部署

本目录可以 `npm run deploy`，但只在 wrangler 已经登录时才值得做。没有自定义域名。

```bash
npx wrangler login
npm ci
npm run check
npm run deploy:dry
npm run deploy
```

部署后：

```text
https://mcp-imgkits-core.<subdomain>.workers.dev/mcp
https://mcp-imgkits-core.<subdomain>.workers.dev/health
```

不要在 `wrangler.jsonc` 加 `routes` 或 `custom_domain`。

`/health` 应看到 `service: mcp-imgkits-core`、`upstream_auth: none`、`billing: gateway-only`、`direct_mcp_allowed: true`，以及 7 个 ready 工具。输出里没有 Secret。

## 错误

工具失败是 MCP `isError: true`，body 为 JSON。常见 code：

| code | 含义 |
|---|---|
| `invalid_arguments` / `invalid_url` / `blocked_url` | 参数或 URL 不合法，未请求上游 |
| `invalid_image` / `image_too_large` / `image_redirect` / `image_download_failed` | 压缩下载阶段失败 |
| `compress_unavailable` / `compress_failed` | 没有可用的 Workers 图片编码 |
| `tool_not_ready` | `erase_object` stub。未请求上游、未记 charge |
| `invalid_upstream_response` | 上游没有结果 URL（含 `{"url":null}`）或返回了 HTML |
| `upstream_rejected` / `upstream_http_error` / `upstream_redirect` / `upstream_unreachable` | 上游错误 |
| `tool_failed_after_charge` | 本地 cost>0 且上游在记账之后失败。带 `charge_id`，没有自动退款 |
| `unauthorized` | `tools/call` 的 Bearer、shared secret 或直连开关不满足 |

402 / 429 / 503 由 gateway 在转发前返回，不会进到本 Worker。

## 目录

```text
src/
  index.ts                 health、公开方法、tools/call 鉴权
  server.ts                7 个 ready 工具；不注册 erase_object
  config.ts                上游基址、COST_*、可见/隐藏工具
  env.ts                   Env / ToolContext。无上游 token
  charge.ts                本地信任 gateway 已扣（零网络）
  upstream.ts              JSON POST/GET，无 Authorization
  urls.ts                  公网 URL 预检
  errors.ts
  tools/                   每个工具一个薄封装；compress 在 Worker 内编码
test/                      积分、URL、上游形状、工具 body、压缩、erase 隐藏、MCP smoke
wrangler.jsonc             workers_dev only，无 routes
```

## 硬闸

- 不改业务仓。
- 没有 `/api/mcp/*`。
- 没有写死的 API key。公开上游不发 Bearer。
- `erase_object` 不是 ready 工具。
