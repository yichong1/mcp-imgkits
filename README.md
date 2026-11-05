# mcp-imgkits

Public monorepo for ImgKits MCP Workers.

| Path | Role |
|------|------|
| [`transmonkey/`](./transmonkey/) | Translation MCP (text / document / image / subtitle + language detect) |
| [`markany/`](./markany/) | Watermark MCP (add / remove / blind embed & decode) |
| [`imgkits-core/`](./imgkits-core/) | Core image MCP (colorize, upscale with face enhance, background, cartoon, extend, resize, compress) |
| [`gateway/`](./gateway/) | Credit gateway (auth, metering, Service Binding aggregation) |

## Use the MCP

- **Endpoint:** `https://mcp.imgkits.com/mcp` (Streamable HTTP)
- **Privacy / get API key / balance:** https://mcp.imgkits.com
- Clients should prefer the gateway URL, not individual `*.workers.dev` hosts.

`initialize` / `tools/list` / `ping` are public; `tools/call` requires `Authorization: Bearer sk_live_…` issued by the gateway.

## Copyright note (MarkAny)

`remove_watermark` is for material you own or are licensed to edit. Callers must pass `confirm_authorization=true`; each caller key is rate-limited (default 5 calls / 60 seconds). See [`markany/README.md`](./markany/README.md) for the full copyright / abuse gate.

## Layout notes

- Business product repos are **not** modified here.
- Secrets (`UPSTREAM_API_TOKEN`, etc.) stay in Cloudflare Worker secrets — never commit `.dev.vars` or real keys.
- Grey-release Workers may still appear on `workers.dev`; production entry is the gateway domain above.
