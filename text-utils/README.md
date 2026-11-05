# mcp-text-utils

Cloudflare Worker MCP server: **pure-algorithm text utilities** (no upstream HTTP).

| Item | Value |
|------|-------|
| Tools | `convert_text_style` (1), `count_text` (1) |
| Endpoint (prod) | via `https://mcp.imgkits.com/mcp` |
| Grey release | `https://mcp-text-utils.409198933.workers.dev` (workers.dev only; no Custom Domain) |

## convert_text_style

- `text` (required, ≤8000 chars)
- `mode`: `morse` | `binary` | `old_english` | `fancy` | `upper` | `lower` | `title` | `reverse`
- Returns `{ text, mode, result }` (+ optional `skipped`)

## count_text

- `text` (required, ≤8000 chars)
- Returns `characters`, `characters_no_whitespace`, `words`, `lines`, `bytes_utf8`

## Secrets

None required. No UPSTREAM secret. Optional `GATEWAY_SHARED_SECRET` only.

## Deferred

- Bank statement parse — not mounted this wave (needs upstream review + no retention).

## Privacy / keys

- Privacy & API keys: https://mcp.imgkits.com
- Text is processed in-memory for the request only and is not stored.
- Billing is gateway-only; this Worker never deducts credits itself.
