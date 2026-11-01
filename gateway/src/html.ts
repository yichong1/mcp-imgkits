const MINERU_LICENSE = "https://github.com/opendatalab/MinerU/blob/master/LICENSE.md";
const MINERU_PROJECT = "https://github.com/opendatalab/MinerU";
const PRIVACY_URL = "https://www.imgkits.com/privacy";

const COMMON_CSS = `
  :root { color-scheme: light dark; --fg:#111827; --muted:#4b5563; --line:#d1d5db; --bg:#ffffff; --accent:#0f766e; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e5e7eb; --muted:#9ca3af; --line:#374151; --bg:#111827; --accent:#5eead4; }
  }
  * { box-sizing: border-box; }
  body { margin:0 auto; max-width: 880px; padding: 2rem 1.25rem 4rem; background: var(--bg); color: var(--fg);
    font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif; }
  h1 { font-size: clamp(1.7rem, 4vw, 2.4rem); line-height:1.2; margin: 0 0 .6rem; }
  h2 { font-size: 1.2rem; margin: 2.2rem 0 .7rem; }
  p, li { color: var(--fg); }
  .lede { color: var(--muted); font-size: 1.08rem; margin: 0 0 1.5rem; }
  .muted { color: var(--muted); }
  a { color: var(--accent); }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  code { background: rgba(127,127,127,.14); padding: .12em .35em; border-radius: 5px; }
  pre { overflow-x:auto; padding: 1rem; border:1px solid var(--line); border-radius: 10px; background: rgba(127,127,127,.08); }
  table { width:100%; border-collapse: collapse; margin: .5rem 0 1rem; }
  th, td { text-align:left; vertical-align:top; padding:.6rem .7rem; border-bottom:1px solid var(--line); }
  th { font-size:.92rem; color: var(--muted); font-weight:600; }
  .callout { border:1px solid var(--line); border-left:4px solid var(--accent); border-radius:8px; padding:.9rem 1rem; margin:1.2rem 0; }
  footer { margin-top:3rem; padding-top:1.2rem; border-top:1px solid var(--line); color:var(--muted); font-size:.92rem; }
  nav a { margin-right:1rem; }
`;

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="ImgKits MCP: convert PDF and images to Markdown, OCR text with bounding boxes, and extract tables. Powered by MinerU.">
<style>${COMMON_CSS}</style>
</head>
<body>
${body}
</body>
</html>`;
}

export function renderHome(): string {
  return shell(
    "ImgKits MCP · 文档转 Markdown / OCR / 表格提取",
    `<nav><a href="/">首页</a><a href="${PRIVACY_URL}">隐私政策</a><a href="/readme">README</a></nav>
<h1>ImgKits MCP</h1>
<p class="lede">把 PDF 和图片交给你的 MCP 客户端：转成干净的 Markdown、提取带坐标的 OCR 文本、抽取表格。按次扣积分，由 ImgKits 积分账户结算。</p>

<div class="callout">
  <strong>MCP 端点（Streamable HTTP）</strong><br>
  <code>POST https://mcp.imgkits.com/mcp</code><br>
  <span class="muted">workers.dev 部署地址同样可用：<code>https://mcp-credit-gateway.&lt;your-subdomain&gt;.workers.dev/mcp</code></span>
</div>

<h2>工具</h2>
<table>
  <thead><tr><th>工具</th><th>用途</th><th>返回</th></tr></thead>
  <tbody>
    <tr><td><code>convert_to_markdown</code></td><td>PDF / 图片 → Markdown，适合 RAG 和 LLM 入库。可选返回 MinerU 版面 JSON。</td><td><code>markdown</code>，可选 <code>layout_json</code></td></tr>
    <tr><td><code>ocr_image</code></td><td>图片、截图、扫描页 → 文本块，带 block 级 <code>bbox</code> 和页码。</td><td><code>blocks[]</code>（<code>type</code>、<code>text</code>、<code>bbox</code>、<code>page_idx</code>）</td></tr>
    <tr><td><code>extract_tables</code></td><td>PDF / 图片 → 表格 HTML 加行列矩阵，合并单元格会展开。</td><td><code>tables[]</code>（<code>html</code>、<code>rows</code>、<code>row_count</code>、<code>column_count</code>、<code>page_idx</code>、<code>bbox</code>）</td></tr>
  </tbody>
</table>
<p class="muted">输入限制：每次 1–5 个公开 <code>https</code> 文件 URL，每个 ≤20 MiB；支持 pdf、png、jpeg、webp、bmp、tiff。本期不支持 DOCX。私有、本地、metadata 主机和带凭据的 URL 会被拒绝。</p>
<p class="muted">配置 <code>MCP_TRANSMONKEY_UPSTREAM</code> 后，同一端点还会聚合 TransMonkey 翻译工具（<code>translate_text</code>、<code>translate_document</code>、<code>translate_image</code>、<code>translate_subtitle</code>、<code>detect_language</code>）。</p>
<p class="muted">配置 <code>MCP_MARKANY_UPSTREAM</code> 后，同一端点还会聚合 MarkAny 水印工具（<code>add_watermark</code>、<code>remove_watermark</code>、<code>embed_blind_watermark</code>、<code>decode_blind_watermark</code>），每个固定扣 1 积分。两个上游都配置且都可用时共 12 个工具。</p>

<h2>试用与获取 API Key</h2>
<p><strong>API Key 由小助理人工代发，本服务不提供自助签发页面。</strong>需要试用时，请联系小助理并提供你的 ImgKits 账号信息；签发后你会得到一把 <code>sk_live_…</code> 密钥，只在签发时显示一次。</p>
<pre>Authorization: Bearer sk_live_...</pre>
<p class="muted">不要把 Key 提交到代码仓库、前端页面或公开日志。Key 泄露时请联系小助理吊销并重新签发。</p>

<h2>计费与退款</h2>
<p>每次工具调用默认扣 1 积分，扣分发生在调用 MinerU 之前。余额不足、限流或扣分服务不可用时会直接失败，不会创建 MinerU 任务。工具在扣分之后失败时没有自动退款，请联系小助理人工处理。</p>

<h2>文档</h2>
<ul>
  <li><a href="/readme">README</a>：完整接口、部署、配置与运维说明。</li>
  <li><a href="${PRIVACY_URL}">隐私政策</a>：完整隐私政策以 ImgKits 页面为准。</li>
  <li><a href="${MINERU_PROJECT}">MinerU 项目</a> 与 <a href="${MINERU_LICENSE}">MinerU LICENSE</a>。</li>
</ul>

<footer>
  <p><strong>Powered by MinerU (opendatalab/MinerU).</strong> License: <a href="${MINERU_LICENSE}">${MINERU_LICENSE}</a></p>
  <p>本仓库是独立的 Cloudflare Worker，不打包 MinerU 源码或模型权重；文件由单独运营的 MinerU 服务处理。上游任务数据临时保存，声明保留时间 ≤24h。</p>
</footer>`,
  );
}

export function renderPrivacy(): string {
  return shell(
    "隐私政策 · ImgKits MCP",
    `<nav><a href="/">首页</a><a href="${PRIVACY_URL}">隐私政策</a><a href="/readme">README</a></nav>
<h1>隐私政策</h1>
<p class="lede">ImgKits 的完整隐私政策请见：<a href="${PRIVACY_URL}">${PRIVACY_URL}</a></p>
<p>本页面是该地址的短跳转说明。ImgKits MCP 不保存你上传的文件内容、文件名或文件 URL，也不保存 MinerU 返回的 Markdown、OCR 文本、表格或版面 JSON。计费流水、Key 元数据和日志处理方式以 ImgKits 隐私政策为准。</p>

<footer>
  <p><strong>Powered by MinerU (opendatalab/MinerU).</strong> License: <a href="${MINERU_LICENSE}">${MINERU_LICENSE}</a></p>
</footer>`,
  );
}

const HTML_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "public, max-age=300",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
};

export function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: HTML_HEADERS });
}
