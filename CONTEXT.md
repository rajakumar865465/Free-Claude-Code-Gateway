# CONTEXT.md — Detailed Project Context

This document captures the full context, history, architecture decisions, and current state of the **Free Claude Code Gateway** project. It is intended for AI agents and developers who need deep understanding of the codebase.

---

## 1. Project Purpose

Free Claude Code Gateway solves a specific problem: many AI coding tools (Claude Code, Cline, Roo Code, Continue.dev, Aider, etc.) are designed to work with Anthropic's Claude API format (`POST /v1/messages`). However, many providers (Kimi, GLM, DeepSeek, and others) offer OpenAI-compatible APIs (`POST /v1/chat/completions`) instead.

This gateway sits in between:
- Accepts Claude/Anthropic API format requests
- Converts them to OpenAI format
- Sends them to the configured upstream provider
- Converts the response back to Claude format

This lets you use any Claude-compatible tool — including Claude Code — with any OpenAI-compatible provider.

---

## 2. Architecture Decisions

### Why Express + TypeScript (no framework)?

- Express is mature, well-understood, and has minimal overhead
- TypeScript provides type safety without runtime cost
- No build pipeline for the frontend (vanilla JS/CSS) keeps deployment simple
- The proxy is a single process, not a microservice — Express is the right fit

### Why CommonJS modules?

The `tsconfig.json` uses `"module": "commonjs"` because:
- Express ecosystem tools (pino, rate-limit) work best with CommonJS
- `tsx` handles CommonJS fine in dev mode
- No ESM-specific features are needed

### Why file-based persistence (not SQLite/Redis)?

- Zero external dependencies
- Works on any platform (Windows, Linux, macOS)
- Simple JSON files are human-readable and debuggable
- Performance is adequate for a proxy handling hundreds of requests
- The `.blueclaude-data/` directory can be gitignored and deleted to reset

### Why no frontend build step?

- The admin dashboard is relatively simple (7 pages, charts, tables)
- Vanilla JS with CDN imports (Chart.js, Google Fonts) avoids npm complexity
- Changes to CSS/JS take effect immediately without rebuilding
- The `public/admin/` directory is served as static files

---

## 3. Request Flow — Deep Dive

### Claude Endpoint (`POST /v1/messages`)

```
Client Request
     │
     ▼
┌─────────────────────────────────────────────────────┐
│  Express Middleware Stack                           │
│  ├── buildCors()           — CORS headers           │
│  ├── express.json()        — Body parsing           │
│  ├── requestContext        — Request ID injection   │
│  ├── buildRateLimiter()    — 60 req/min/IP          │
│  ├── authMiddleware        — PROXY_API_KEY check    │
│  └── buildRequestLogMiddleware() — Capture response │
└─────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────┐
│  messages.routes.ts                                │
│  1. Validate Anthropic request body                │
│  2. Resolve model via ModelRegistry                │
│  3. Convert: Anthropic → OpenAI format             │
│  4. Call UpstreamService.chat()                    │
│  5. Convert: OpenAI → Anthropic response           │
│  6. Record to RequestLog                           │
│  7. Return Anthropic-format response               │
└─────────────────────────────────────────────────────┘
     │
     ▼
Upstream AI Provider (Kimi, GLM, DeepSeek, etc.)
```

### OpenAI Endpoint (`POST /v1/chat/completions`)

```
Client Request
     │
     ▼
┌─────────────────────────────────────────────────────┐
│  chat-completions.routes.ts                        │
│  1. Replace client API key with server key         │
│  2. Forward body to upstream provider              │
│  3. Stream or buffer response                      │
│  4. Record to RequestLog                           │
└─────────────────────────────────────────────────────┘
     │
     ▼
Upstream AI Provider (Kimi, GLM, DeepSeek, etc.)
```

---

## 4. Admin Dashboard Architecture

### Backend (Admin API)

The admin system is a self-contained module in `src/admin/`:

```
AdminState (wires everything)
├── RequestLog          — Circular buffer with subscriber pattern
├── StatsEngine         — Computes aggregates from RequestLog
├── ConfigManager       — Runtime config with file persistence
├── ModelRegistry       — Runtime model mappings with file persistence
├── ConnectionTester    — Sends real test requests
└── buildAdminAuth()    — HTTP Basic auth middleware
```

**Key design decisions:**
- `RequestLog` uses a subscriber pattern for SSE — when a new request is recorded, all connected SSE clients receive it immediately
- `StatsEngine` computes stats on-the-fly from the log (no separate aggregation needed)
- `ConfigManager` and `ModelRegistry` overlay runtime changes on top of env/file defaults
- All persistence uses debounced saves (2s for request log) to avoid excessive disk writes

### Frontend (SPA)

The dashboard is a single-page application with 7 views:

| View | Purpose | Key Features |
|------|---------|--------------|
| Overview | Dashboard | KPI cards, Chart.js charts, model usage table |
| Live Requests | Real-time feed | SSE connection, pause/resume, request drawer |
| Playground | API testing | Send Claude or OpenAI requests, streaming support |
| Providers | Provider status | Connection info, API key status, stats |
| Model Router | Mappings | CRUD for Claude→provider model mappings |
| Settings | Config | Update base URL, rate limits, timeout, etc. |
| Diagnostics | Health check | Step-by-step connection test timeline |

**Technical details:**
- Vanilla JavaScript (no framework)
- Chart.js via CDN for charts
- Google Fonts (Inter) for typography
- Command palette (⌘K / Ctrl+K) for quick navigation
- SSE (EventSource) for real-time updates
- CSS custom properties for theming (light theme, #F6F8FC background)

---

## 5. Data Persistence

### Storage Location

All data is stored in `.blueclaude-data/` relative to the project root:

```
.blueclaude-data/
├── request-log.json      — Request history (max 1000 entries)
├── config-overrides.json — Runtime config changes
└── model-registry.json   — Model mapping overrides
```

### Request Log Persistence

- On startup: loads existing entries from disk
- On each new request: debounced save (2s delay)
- On clear: immediately writes empty array
- Capacity: 1000 entries (oldest pruned first)

### Config Persistence

- On startup: loads overrides from disk
- On each update: immediately writes to disk
- Only overrides are stored (not the full config)

### Model Registry Persistence

- On startup: loads mappings from disk
- On each replace: immediately writes to disk
- Empty mappings are treated as "no override"

---

## 6. Error Handling Strategy

### Upstream Errors → Anthropic Format

All upstream errors are converted to Anthropic's error format:

```json
{
  "type": "error",
  "error": {
    "type": "authentication_error",
    "message": "Invalid API key"
  }
}
```

Error type mapping:
| Upstream Status | Anthropic Error Type |
|-----------------|---------------------|
| 401 | `authentication_error` |
| 403 | `permission_error` |
| 404 | `invalid_request_error` |
| 429 | `rate_limit_error` |
| 500+ | `api_error` |
| Timeout | `timeout_error` |
| Overloaded | `overloaded_error` |

### Request Validation

Before sending upstream, requests are validated:
- `messages` array must be non-empty
- `temperature` must be 0-1 (Anthropic range) or 0-2 (OpenAI range)
- `top_p` must be 0-1
- Image input is rejected (`unsupported_feature`)
- Tool calling is supported (converted to OpenAI format)

---

## 7. Security Model

### API Key Protection

1. **Upstream API Key** — Read from `BLUESMINDS_API_KEY` env var, never logged or exposed to clients
2. **Proxy API Key** — Optional `PROXY_API_KEY` protects proxy endpoints
3. **Admin Password** — Optional `ADMIN_PASSWORD` protects admin dashboard
4. **Redaction** — All sensitive fields (authorization, api-key, secret, password, token) are automatically redacted in logs

### CORS Policy

- Development: allows all origins
- Production: locked to `ALLOWED_ORIGINS` when set

### Rate Limiting

- Default: 60 requests per minute per IP
- Configurable via `RATE_LIMIT_PER_MINUTE`

---

## 8. Current State (as of this writing)

### What's Working

- ✅ Full Claude ↔ OpenAI conversion (non-streaming and streaming)
- ✅ Streaming via Claude endpoint (`stream: true` fully supported)
- ✅ Streaming via OpenAI passthrough (`/v1/chat/completions` with `stream: true`)
- ✅ Tool calling conversion (Anthropic ↔ OpenAI format)
- ✅ OpenAI passthrough (streaming supported)
- ✅ Model mapping (file + runtime overrides)
- ✅ Admin dashboard (7 pages, sidebar layout)
- ✅ Real-time SSE request feed
- ✅ Data persistence (file-based JSON)
- ✅ HTTP Basic auth for admin
- ✅ Playground (test requests from UI)
- ✅ Diagnostics (connection health check)
- ✅ Command palette (⌘K)
- ✅ Request detail drawer
- ✅ Chart.js integration
- ✅ Mobile-responsive design
- ✅ TypeScript clean (`tsc --noEmit`)

### What's NOT Working Yet

- ❌ Multimodal (image) input
- ❌ Prompt caching

### Known Limitations

- Request log is capped at 1000 entries
- No authentication on SSE endpoint (inherits admin auth)
- No WebSocket support
- No batch request support

---

## 9. File Inventory

### Source Files (31 TypeScript files)

| File | Lines | Purpose |
|------|-------|---------|
| `src/server.ts` | 133 | Entry point, Express app creation |
| `src/config/env.ts` | 93 | Environment variable parsing |
| `src/config/models.ts` | ~50 | Model config loader |
| `src/middleware/auth.ts` | ~40 | API key authentication |
| `src/middleware/cors.ts` | ~30 | CORS configuration |
| `src/middleware/error-handler.ts` | ~50 | Error handling |
| `src/middleware/rate-limit.ts` | ~20 | Rate limiting |
| `src/middleware/request-logger.ts` | ~40 | Request logging |
| `src/routes/health.routes.ts` | 26 | Health endpoints |
| `src/routes/models.routes.ts` | ~30 | Models endpoint |
| `src/routes/messages.routes.ts` | ~80 | Claude messages endpoint |
| `src/routes/chat-completions.routes.ts` | ~60 | OpenAI passthrough |
| `src/services/bluesminds.service.ts` | ~100 | Upstream HTTP client |
| `src/converters/anthropic-to-openai.ts` | ~120 | Request conversion |
| `src/converters/openai-to-anthropic.ts` | ~100 | Response conversion |
| `src/converters/errors.ts` | ~80 | Error mapping |
| `src/types/anthropic.ts` | ~60 | Claude types |
| `src/types/openai.ts` | ~50 | OpenAI types |
| `src/types/config.ts` | ~20 | Config types |
| `src/utils/logger.ts` | ~30 | Pino setup |
| `src/utils/redact.ts` | ~60 | Redaction helpers |
| `src/utils/request-id.ts` | ~15 | Request ID |
| `src/utils/timeout.ts` | ~20 | Timeout wrapper |
| `src/admin/admin-state.ts` | 21 | Admin wiring |
| `src/admin/persist.ts` | ~35 | File persistence |
| `src/admin/request-log.ts` | ~95 | Request log |
| `src/admin/request-log-middleware.ts` | ~40 | Log middleware |
| `src/admin/stats-engine.ts` | 131 | Stats computation |
| `src/admin/config-manager.ts` | ~220 | Config management |
| `src/admin/model-registry.ts` | ~95 | Model registry |
| `src/admin/connection-tester.ts` | ~40 | Connection test |
| `src/admin/middleware/admin-auth.ts` | ~30 | Basic auth |
| `src/admin/routes/admin-api.routes.ts` | 166 | Admin API |

### Frontend Files

| File | Lines | Purpose |
|------|-------|---------|
| `public/admin/index.html` | 452 | SPA HTML |
| `public/admin/assets/dashboard.css` | 503 | Styles |
| `public/admin/assets/dashboard.js` | ~750 | JavaScript |

### Test Files

| File | Tests | Purpose |
|------|-------|---------|
| `tests/converter.test.ts` | 18 | Content/system conversion |
| `tests/errors.test.ts` | 9 | Error mapping |
| `tests/messages.test.ts` | 10 | Request validation |
| `tests/models.test.ts` | 5 | Model resolution |
| `tests/redact.test.ts` | 6 | Redaction |

### Config/Deploy Files

| File | Purpose |
|------|---------|
| `config/models.json` | Default model mappings |
| `Dockerfile` | Docker build |
| `docker-compose.yml` | Docker Compose setup |
| `ecosystem.config.cjs` | PM2 config |
| `deploy/nginx/blueclaude-proxy.conf` | Nginx config |
| `.env.example` | Environment template |

---

## 10. Development History

### Phase 1: Core Proxy (MVP)

- Built Express server with TypeScript
- Implemented Claude → OpenAI request conversion
- Implemented OpenAI → Claude response conversion
- Added error mapping (401, 403, 404, 429, 500, timeout)
- Added model mapping (config/models.json)
- Added rate limiting, CORS, auth
- Added Pino logging with redaction
- Wrote 47 tests

### Phase 2: Admin Dashboard

- Built admin backend (9 API endpoints)
- Added SSE for real-time request feed
- Added stats engine (per-model breakdowns, latency percentiles)
- Added runtime config manager
- Added runtime model registry
- Added connection tester
- Added HTTP Basic auth
- Built SPA frontend (dark theme, top-tab navigation)
- Added Chart.js integration

### Phase 3: UI/UX Redesign

- Redesigned to sidebar layout (7 pages)
- Changed to light theme (#F6F8FC background, Inter font)
- Added Playground page (test requests from UI)
- Added Providers page (provider cards)
- Added Diagnostics page (step-by-step health check)
- Added Settings page (config form)
- Added Model Router page (mappings CRUD)
- Added command palette (⌘K)
- Added request detail drawer
- Added mobile-responsive design
- Added persistence banner

### Phase 4: Data Persistence

- Created `src/admin/persist.ts` (file-based JSON storage)
- Added persistence to RequestLog (debounced saves)
- Added persistence to ConfigManager (immediate saves)
- Added persistence to ModelRegistry (immediate saves)
- Updated banner from "In-memory only" to "Data Persisted"
- Added `.blueclaude-data/` to `.gitignore`

---

## 11. Future Considerations

### Potential Improvements

1. **Streaming Support** — Convert OpenAI SSE to Anthropic SSE format
2. **Tool Calling** — Convert Anthropic tools/tool_use to OpenAI tools/tool_calls
3. **Multimodal** — Support image input when provider supports it
4. **Prompt Caching** — Cache system prompts for efficiency
5. **Multi-Provider** — Route to different providers based on model
6. **API Key Management** — Generate/revoke proxy API keys from admin UI
7. **Analytics** — Date-range filtering, usage reports
8. **Error Center** — Structured error logging and analysis

### Scaling Considerations

- Current design is single-process, single-instance
- For multi-instance: consider Redis for shared state
- For high throughput: consider streaming instead of buffering
- For production: add health checks, metrics endpoints

---

## 12. Key Contacts

- **Project Owner:** deba_pc.com
- **Location:** `C:\Users\deba_pc.com\OneDrive\Desktop\cloude cloude\bluesminds-claude-proxy`
- **Environment:** Windows (PowerShell)
- **Node Version:** 20+
- **Default Port:** 8787
