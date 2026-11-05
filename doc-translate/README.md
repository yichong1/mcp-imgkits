# mcp-doc-translate

Cloudflare Worker MCP server: **PDF → Markdown (MinerU S2S) → translate** (public `/translate/text`).

| Item | Value |
|------|-------|
| Tool | `pdf_to_markdown_then_translate` |
| Cost (gateway) | **2** credits once (MinerU 1 + translate_text 1) |
| Endpoint (prod) | via `https://mcp.imgkits.com/mcp` |
| Grey release | `https://mcp-doc-translate.409198933.workers.dev` (workers.dev only; no Custom Domain) |

## Inputs

- `file_url` **or** `files: [url]` (exactly one public http(s) PDF; path must end in `.pdf`)
- `target_lang` (required)
- optional `source_lang` (default `auto`), `include_source_markdown` (default true), `wait_seconds`

## Outputs

`markdown`, `translated_markdown`, `bilingual_markdown`, `task_id`, `target_lang`

## Secrets

- `UPSTREAM_API_TOKEN` — MinerU 路B bearer only (`wrangler secret put`). Never commit.
- **No** translate-side secret. Public `/translate/text` is called without Authorization.

## Deferred

- DOCX input — not mounted this wave.

## Privacy / keys

- Privacy & API keys: https://mcp.imgkits.com
- Billing is gateway-only; this Worker never deducts credits itself.

## Compliance

Use only on documents you own or are authorized to convert/translate. Calls are metered.
