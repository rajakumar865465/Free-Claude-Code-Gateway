# Changelog

All notable changes to Free Claude Code Gateway are documented here.

---

## [1.0.0] — 2026-06-08

### Added
- `POST /v1/messages` — Full Claude/Anthropic-compatible endpoint with request validation, model resolution, and format conversion.
- `POST /v1/chat/completions` — OpenAI-compatible passthrough with server-side key injection.
- `GET /v1/models` — Upstream model list passthrough.
- `GET /health` and `GET /` — Health check and service info endpoints.
- **Model Router** — Glob pattern family rules and exact model mappings via `config/models.json`.
- **Admin Dashboard** — Full-featured SPA at `/admin` with 7 views (Overview, Live Requests, Playground, Providers, Model Router, Settings, Diagnostics).
- **Real-time SSE** — Live request feed with pause/resume and per-request drawer.
- **Data Persistence** — Request history, config overrides, and model mappings survive restarts via JSON files in `.blueclaude-data/`.
- **Runtime Config Manager** — Update provider URL, rate limits, timeouts and other settings from the Admin UI without restarting.
- **Stats Engine** — Per-model breakdown with latency percentiles (P50, P95), error rates, token counts, and cost estimates.
- **Streaming support** — Full Claude streaming via Server-Sent Events (`message_start`, `content_block_*`, `message_delta`, `message_stop`).
- **Tool calling** — Anthropic tools/tool_use ↔ OpenAI tools/tool_calls conversion.
- **Command Palette** — `⌘K` / `Ctrl+K` quick navigation in the admin UI.
- **API Playground** — Send and inspect Claude or OpenAI requests directly from the admin UI.
- Docker, Docker Compose, PM2, and Nginx deployment configs.
- TypeScript strict mode throughout with zero `any` in production code.
- 6 test files covering conversion, validation, error mapping, model routing, and redaction.

### Security
- API keys read from environment only, never logged or returned to clients.
- All authorization headers redacted via Pino `redact` paths.
- `safeStringify` helper redacts keys matching `/authorization|api[-_]?key|secret|password|token/i`.
- Optional `PROXY_API_KEY` to require bearer auth on all proxy endpoints.
- Optional `ADMIN_PASSWORD` for HTTP Basic auth on the admin dashboard.
- Rate limiting on by default (60 req/min/IP).
