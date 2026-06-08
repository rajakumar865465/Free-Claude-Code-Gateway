# AGENT.md — Instructions for AI Agents

This file provides context for AI coding assistants working on the **Free Claude Code Gateway** project.

---

## MANDATORY RULES

### Documentation Sync Rule

**Every time you make ANY change to this project, you MUST also update the documentation files to reflect that change.**

Specifically:

1. **CONTEXT.md** — Update the following sections as needed:
   - "Current State" section — mark new features as ✅, update "What's Working" list
   - "File Inventory" section — add/remove/modify file entries
   - "Development History" — append a new entry describing what was done
   - "Known Limitations" — remove items that are now fixed
   - "Future Considerations" — remove items that are now implemented
   - Any other section affected by your change

2. **README.md** — Update the following sections as needed:
   - "Features" list — add new features
   - "Configuration" — add new env vars to the table
   - "Endpoints" — add new API endpoints
   - "Project layout" — add new files to the tree
   - "Curl examples" — add examples for new endpoints
   - Any other section affected by your change

3. **AGENT.md** (this file) — Update if:
   - New files are added to the project structure
   - New commands are added
   - New patterns or conventions are introduced
   - New environment variables are added

### When to Update Documentation

| Change Type | CONTEXT.md | README.md | AGENT.md |
|-------------|------------|-----------|----------|
| New feature | ✅ Update "Current State" + "File Inventory" | ✅ Update "Features" | ✅ Update if new file |
| Bug fix | ✅ Update "Current State" | — | — |
| New env variable | ✅ Update if needed | ✅ Update config table | ✅ Update env table |
| New API endpoint | ✅ Update "File Inventory" | ✅ Add endpoint + curl example | ✅ Update structure |
| New admin page | ✅ Update "Current State" | ✅ Update dashboard section | ✅ Update structure |
| New test file | ✅ Update "File Inventory" | ✅ Update test section | ✅ Update structure |
| Config change | ✅ Update relevant section | ✅ Update config section | — |
| Refactor (no feature change) | ✅ Update "File Inventory" | — | ✅ Update structure |

### Documentation Quality Standards

- Keep descriptions factual and current — no outdated information
- Use consistent formatting (Markdown tables, code blocks, bullet points)
- Include file paths with line numbers when referencing specific code
- Add examples for new features (curl commands, config snippets)
- Cross-reference related sections (e.g., link new env vars to their usage)

---

## Project Overview

Free Claude Code Gateway is an Express/TypeScript API gateway that translates **Anthropic Claude API** format to any **OpenAI-compatible API** (Kimi, GLM, DeepSeek, and other providers). It allows tools expecting Claude's `/v1/messages` endpoint to work with any OpenAI-compatible provider.

**Stack:** TypeScript, Express 4, Pino, Node.js 20+
**No build-step frontend:** Admin dashboard is vanilla JS/CSS served as static files from `public/admin/`.

---

## Commands

| Command | What it does |
|---------|-------------|
| `npm run dev` | Start dev server with tsx watch |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled JS from `dist/` |
| `npm test` | Run tests: `node --test --import tsx tests/**/*.test.ts` |
| `npm run typecheck` | `tsc --noEmit` |

**Always run `npm run typecheck` and `npm test` after making changes.**

---

## Project Structure

```
src/
├── server.ts                    # Entry point — creates Express app, mounts all routes
├── config/
│   ├── env.ts                   # AppConfig interface, loadConfig() from env vars
│   └── models.ts                # Model mapping loader (config/models.json)
├── middleware/
│   ├── auth.ts                  # PROXY_API_KEY bearer/auth middleware
│   ├── cors.ts                  # CORS configuration
│   ├── error-handler.ts         # Express error handler + 404
│   ├── rate-limit.ts            # express-rate-limit wrapper
│   └── request-logger.ts       # Request ID injection + pino logging
├── routes/
│   ├── health.routes.ts         # GET /health, GET /
│   ├── models.routes.ts         # GET /v1/models (passthrough)
│   ├── messages.routes.ts       # POST /v1/messages (Claude → OpenAI conversion)
│   └── chat-completions.routes.ts # POST /v1/chat/completions (passthrough)
├── services/
│   └── bluesminds.service.ts    # HTTP client to upstream provider API
├── converters/
│   ├── anthropic-to-openai.ts   # Claude request → OpenAI request
│   ├── openai-to-anthropic.ts   # OpenAI response → Claude response
│   └── errors.ts                # Upstream error → Anthropic error format
├── types/
│   ├── anthropic.ts             # Claude request/response types
│   ├── openai.ts                # OpenAI request/response types
│   └── config.ts                # ModelMappingConfig type
├── utils/
│   ├── logger.ts                # Pino logger with redaction
│   ├── redact.ts                # API key redaction helpers
│   ├── request-id.ts            # X-Request-Id header injection
│   └── timeout.ts               # AbortController timeout wrapper
└── admin/
    ├── admin-state.ts           # Wires all admin services together
    ├── persist.ts               # File-based JSON persistence (.blueclaude-data/)
    ├── request-log.ts           # Circular buffer + file persistence + subscriber pattern
    ├── request-log-middleware.ts # Captures res.json() body for token counting
    ├── stats-engine.ts          # Computes overall + per-model stats
    ├── config-manager.ts        # Runtime config overlay with persistence
    ├── model-registry.ts        # Runtime model mapping overlay with persistence
    ├── connection-tester.ts     # Sends real test request to upstream
    ├── middleware/
    │   └── admin-auth.ts        # HTTP Basic auth for /admin
    └── routes/
        └── admin-api.routes.ts  # All admin API endpoints

public/admin/
├── index.html                   # SPA with sidebar layout
├── assets/
│   ├── dashboard.css            # Light theme, Inter font, responsive
│   └── dashboard.js             # Vanilla JS, Chart.js, SSE, command palette
```

---

## Key Patterns

### Request Flow (Claude endpoint)

1. `POST /v1/messages` hits `messages.routes.ts`
2. `authMiddleware` checks `PROXY_API_KEY` if set
3. `buildRequestLogMiddleware` wraps `res.json()` to capture response body
4. Request validated by `anthropic-to-openai.ts`
5. Model resolved by `ModelRegistry.resolve()`
6. `UpstreamService.chat()` sends converted request upstream
7. Response converted back by `openai-to-anthropic.ts`
8. Request logged to `RequestLog` (with persistence)

### Admin API

All admin endpoints are under `/admin/api/*` and require HTTP Basic auth when `ADMIN_PASSWORD` is set.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/admin/api/stats` | GET | Overall + per-model statistics |
| `/admin/api/requests` | GET | Request log (newest first) |
| `/admin/api/config` | GET/PUT | Runtime config (no API key exposed) |
| `/admin/api/models/mappings` | GET/PUT | Model mapping overrides |
| `/admin/api/models/available` | GET | Fetch upstream model list |
| `/admin/api/test-connection` | POST | Send test request to upstream |
| `/admin/api/events` | GET | SSE stream of new requests |
| `/admin/api/stats/clear` | POST | Wipe request log + stats |

### Persistence

Data is stored in `.blueclaude-data/` as JSON files:
- `request-log.json` — Request history (debounced saves)
- `config-overrides.json` — Runtime config overrides
- `model-registry.json` — Model mapping overrides

Delete `.blueclaude-data/` to reset all stored data.

### Model Resolution Order

1. Exact match in `config/models.json` → provider model
2. Runtime override in `ModelRegistry`
3. Incoming model name verbatim (non-strict mode)
4. `default` field
5. Error if strict mode

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BLUESMINDS_API_KEY` | yes | — | Upstream provider API key |
| `BLUESMINDS_BASE_URL` | no | `https://api.example.com/v1` | Provider base URL |
| `PORT` | no | `8787` | Server port |
| `DEFAULT_MODEL` | no | `gpt-4.1` | Fallback model |
| `STRICT_MODEL_MAPPING` | no | `false` | Reject unknown models |
| `PROXY_API_KEY` | no | — | Protect proxy endpoints |
| `REQUEST_TIMEOUT_MS` | no | `120000` | Upstream timeout |
| `RATE_LIMIT_PER_MINUTE` | no | `60` | Per-IP rate limit |
| `MAX_BODY_SIZE` | no | `20mb` | Request body limit |
| `ALLOWED_ORIGINS` | no | — | CORS origins |
| `DEBUG_LOGS` | no | `false` | Verbose logging |
| `ADMIN_PASSWORD` | no | — | HTTP Basic auth for /admin |
| `NODE_ENV` | no | `development` | Environment |

---

## Conventions

- **TypeScript strict mode** — no `any` unless absolutely necessary
- **No comments** unless the user explicitly asks for them
- **CommonJS modules** (`"module": "commonjs"` in tsconfig)
- **ES2022 target** — modern JS features available
- **Pino for logging** — never use `console.log` in production code
- **Redaction** — never log API keys, always use `redact.ts` helpers
- **Error mapping** — upstream errors must be converted to Anthropic error format
- **Static frontend** — no build step, vanilla JS/CSS, CDN imports for Chart.js and Google Fonts

---

## Testing

Tests use Node.js built-in `node --test` with `tsx` loader. Test files:

- `tests/converter.test.ts` — Anthropic ↔ OpenAI conversion
- `tests/errors.test.ts` — Error mapping
- `tests/messages.test.ts` — Messages route validation
- `tests/models.test.ts` — Model mapping resolution
- `tests/redact.test.ts` — API key redaction

---

## Common Tasks

### Add a new admin API endpoint
1. Add route to `src/admin/routes/admin-api.routes.ts`
2. If new service needed, create in `src/admin/` and wire in `admin-state.ts`

### Add a new environment variable
1. Add to `AppConfig` interface in `src/config/env.ts`
2. Add parsing in `loadConfig()`
3. Add to `.env.example`

### Modify model mapping defaults
1. Edit `config/models.json`
2. Or update `ModelRegistry` constructor defaults

### Change persistence behavior
1. Edit `src/admin/persist.ts` for storage mechanism
2. Modify `saveJson`/`loadJson` calls in `request-log.ts`, `config-manager.ts`, `model-registry.ts`
