# mcp-imgkits

Public monorepo for ImgKits MCP Workers. The production server is Streamable HTTP and aggregates translation, blind watermark embed and decode, photo colorize, audio tools, PDF→Markdown→translate, and text utilities. The same endpoint also serves document OCR already mounted on the gateway (`convert_to_markdown`, `ocr_image`, `extract_tables`).

| Path | Role |
|------|------|
| [`transmonkey/`](./transmonkey/) | Translation (text / document / image / subtitle + language detect) |
| [`markany/`](./markany/) | Blind watermark embed and decode (`embed_blind_watermark`, `decode_blind_watermark`) |
| [`imgkits-core/`](./imgkits-core/) | Photo colorize (`colorize_photo`) |
| [`audio/`](./audio/) | Audio tools (stem separation, text-to-speech, voice clone, sound effects) |
| [`doc-translate/`](./doc-translate/) | PDF→Markdown→translate (`pdf_to_markdown_then_translate`) |
| [`text-utils/`](./text-utils/) | `convert_text_style`, `count_text` |
| [`gateway/`](./gateway/) | Credit gateway (auth, metering, aggregation) |

## Use the MCP

- **Endpoint:** `https://mcp.imgkits.com/mcp` (Streamable HTTP)
- **Privacy / get API key / balance:** https://mcp.imgkits.com
- Clients should prefer the gateway URL, not individual `*.workers.dev` hosts.

`initialize` / `tools/list` / `ping` are public; `tools/call` requires `Authorization: Bearer sk_live_…` issued by the gateway.

## Layout notes

- Business product repos are **not** modified here.
- Secrets (`UPSTREAM_API_TOKEN`, etc.) stay in Cloudflare Worker secrets — never commit `.dev.vars` or real keys.
- Grey-release Workers may still appear on `workers.dev`; production entry is the gateway domain above.
- License: MIT (`LICENSE`).
