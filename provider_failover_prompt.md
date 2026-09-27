# AUTO PROVIDER FAILOVER + ADMIN DASHBOARD — CLAUDE CODE PROMPT

---

## CONTEXT SCAN (DO FIRST)

Before writing a single line of code, scan and read the following files in the project to understand the existing architecture:

1. **Provider configuration** — find where AI providers (OpenAI, Anthropic, Groq, Together, etc.) are defined. Look for files named: `providers.ts`, `config.ts`, `ai.ts`, `llm.ts`, `models.ts`, `settings.ts`, or any file with `provider` in the name.

2. **API request layer** — find where the actual HTTP/SDK calls to provider APIs are made. Look for files like: `chat.ts`, `completion.ts`, `generate.ts`, `route.ts` under `/api/`, `/lib/`, or `/server/`.

3. **Admin panel** — find existing admin routes or pages. Look for `/admin/`, `/dashboard/`, `/settings/` directories.

4. **Database/storage** — find how the app stores config (Prisma schema, Drizzle schema, `.env` references, localStorage, Supabase, Neon, MongoDB, etc.).

5. **Environment config** — read `.env.example` or `.env.local` to understand which `PROVIDER_API_KEY` variables exist.

**READ ALL OF THESE FILES BEFORE MAKING ANY CHANGES. Do not guess at file names.**

---

## CRITICAL RULES — READ BEFORE ANYTHING ELSE

```
✅ ADD only new files and new code blocks
✅ EDIT only the specific lines needed to inject failover hooks
❌ NEVER delete existing logic, routes, functions, or components
❌ NEVER refactor, rename, or restructure existing code
❌ NEVER change existing API contracts, response shapes, or function signatures
❌ NEVER modify UI of existing pages (only add the new admin page)
❌ NEVER remove existing environment variables or config keys
```

Every change you make must be surgical. If you need to wrap existing logic, wrap it — do not replace it.

---

## WHAT TO BUILD

### Feature 1 — Auto Provider Failover Engine

**File to create:** `lib/provider-failover/engine.ts` (or equivalent path in the project's `lib/` or `utils/` folder)

Build a `ProviderFailoverEngine` class with this exact behavior:

#### Retry Logic (Per Request)

When a provider API call returns a **429**, **503**, **502**, **ECONNRESET**, or any error whose message includes `"rate limit"`, `"quota"`, `"overloaded"`, or `"capacity"`:

```
Attempt 1 → wait 2 seconds → retry same provider
Attempt 2 → wait 5 seconds → retry same provider  
Attempt 3 → FAIL this provider, mark it as rate-limited
           → Select next healthy provider from ranked list
           → Execute the original request payload on new provider
           → Log the switch event to the database
```

If ALL providers are rate-limited or unhealthy, return the last error with a clear message: `"All providers currently unavailable. Please try again in a few minutes."` — never throw a raw 429 to the end user.

#### Provider Health Checker (Background)

Every **5 minutes**, run a lightweight health check against every configured provider:
- Send a minimal test payload (e.g., `max_tokens: 1`, `messages: [{role:"user", content:"ping"}]`)
- If response is 200 → mark provider `HEALTHY`, clear any rate-limit flag
- If response is 429 → mark provider `RATE_LIMITED`
- If response is 401/403 → mark provider `AUTH_ERROR` (invalid key)
- If timeout > 10s or network error → mark provider `UNREACHABLE`

Use `setInterval` in a singleton pattern so only one health checker runs per server process. On serverless (Vercel/Next.js edge), use a cron route instead (see File 4 below).

#### Provider Selection Algorithm

```
Priority order (always try in this sequence):
1. Provider currently marked HEALTHY with lowest error count in last 1 hour
2. Provider marked HEALTHY with fewest recent switches away from it
3. Provider that most recently recovered from RATE_LIMITED status
4. Skip any provider with AUTH_ERROR entirely (requires manual fix)
```

Detect environment automatically:
- If `process.env.OPENAI_API_KEY` exists → register OpenAI providers
- If `process.env.ANTHROPIC_API_KEY` exists → register Anthropic providers  
- If `process.env.GROQ_API_KEY` exists → register Groq providers
- If `process.env.TOGETHER_API_KEY` exists → register Together AI providers
- If `process.env.GOOGLE_API_KEY` or `process.env.GEMINI_API_KEY` exists → register Google providers
- Adapt this list to whatever provider keys actually exist in the project's `.env.example`

---

### Feature 2 — Database Schema (Minimal Additions Only)

**Find the existing DB schema file** (Prisma, Drizzle, or raw SQL) and ADD these new tables/collections only. Do not modify existing tables.

#### Table: `provider_status`
```
id          String   @id @default(cuid())
provider    String   — provider name (e.g. "openai", "anthropic", "groq")
model       String   — model ID (e.g. "gpt-4o", "claude-3-5-sonnet")
status      String   — "HEALTHY" | "RATE_LIMITED" | "AUTH_ERROR" | "UNREACHABLE"
errorCount  Int      @default(0)
lastChecked DateTime @updatedAt
lastError   String?  — last error message
responseMs  Int?     — last health check response time in ms
createdAt   DateTime @default(now())
```

#### Table: `provider_switch_log`
```
id              String   @id @default(cuid())
fromProvider    String   — provider we switched FROM
fromModel       String   — model we switched FROM
toProvider      String   — provider we switched TO
toModel         String   — model we switched TO
reason          String   — e.g. "429_rate_limit" | "503_unavailable" | "timeout"
attemptNumber   Int      — which attempt triggered the switch (1, 2, or 3)
requestId       String?  — optional correlation ID from the original request
userId          String?  — optional user ID if auth exists
responseTime    Int?     — ms it took on the new provider
success         Boolean  @default(true)
createdAt       DateTime @default(now())
```

#### Table: `failover_config`
```
id              String   @id @default(cuid())
key             String   @unique
value           String
updatedAt       DateTime @updatedAt
```

**Seed `failover_config` with these defaults:**
```
{ key: "failover_enabled",      value: "true"  }
{ key: "health_check_interval", value: "300"   }  ← seconds
{ key: "max_retries",           value: "3"     }
{ key: "retry_delay_1",         value: "2000"  }  ← ms
{ key: "retry_delay_2",         value: "5000"  }  ← ms
{ key: "alert_on_switch",       value: "false" }
```

After creating/migrating the schema, run the migration command appropriate for the ORM in use.

---

### Feature 3 — Injection Point (Minimal Edit to Existing Code)

**Find the exact function** in the existing codebase where API calls to AI providers are made. It will look something like:

```typescript
// Example — adapt to whatever exists in the project
const response = await openai.chat.completions.create({ ... })
// OR
const response = await anthropic.messages.create({ ... })
// OR  
const completion = await fetch(`${provider.baseUrl}/v1/chat/completions`, { ... })
```

**Wrap ONLY this call** with the failover engine. Do not change anything else in the function:

```typescript
// BEFORE (existing code — do not remove):
const response = await existingProviderCall(payload)

// AFTER (wrap with failover — keep original as fallback):
const response = await providerFailoverEngine.executeWithFailover(
  () => existingProviderCall(payload),
  {
    providerId: currentProvider.id,
    modelId: currentModel.id,
    requestId: requestId ?? undefined,
    userId: session?.user?.id ?? undefined,
  }
)
```

The `executeWithFailover` method must:
1. Try the lambda passed to it
2. On 429/rate-limit error, apply the 3-attempt retry + switch logic
3. When switching providers, call the existing provider-switch logic that ALREADY EXISTS in the codebase (the path the user manually follows via the admin toggle). Do NOT invent a new switching mechanism — use the one already there.
4. Return the response in exactly the same shape as the original call would have returned

---

### Feature 4 — Cron/Health Check Route

**Create file:** `app/api/cron/provider-health/route.ts` (Next.js App Router) or equivalent

```typescript
// GET /api/cron/provider-health
// Called by: Vercel Cron, self-invocation, or external cron
// Secured by: CRON_SECRET env variable

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 })
  }
  
  await providerFailoverEngine.runHealthChecks()
  return Response.json({ ok: true, timestamp: new Date().toISOString() })
}
```

If the project already has Vercel config (`vercel.json`), ADD this cron entry without removing existing crons:
```json
{
  "crons": [
    { "path": "/api/cron/provider-health", "schedule": "*/5 * * * *" }
  ]
}
```

---

### Feature 5 — Admin Dashboard Page

**Create file:** `app/admin/provider-failover/page.tsx` (or equivalent admin route)

**Design spec — use this exactly:**

#### Layout
Full-width dashboard page. No card wrapper around the whole page. White surfaces only. Clean flat design. Sentence case everywhere.

#### Section 1 — Status bar (top)
A horizontal bar with 3 metric cards side by side:
- **Auto-failover** — shows "Active" (green badge) or "Paused" (amber badge) + a toggle switch to enable/disable
- **Providers healthy** — shows "X / Y" count in large text  
- **Switches today** — shows integer count of switches in last 24h

#### Section 2 — Provider health grid
A responsive grid (3 columns on desktop, 1 on mobile) of provider cards. Each card shows:

```
┌─────────────────────────────────┐
│ [colored dot] OpenAI  [badge]   │
│ gpt-4o                          │
│ ─────────────────────────────── │
│ Response time    342ms          │
│ Error count (1h) 0              │
│ Last checked     2 min ago      │
│ Last error       —              │
└─────────────────────────────────┘
```

- **Dot colors:** Green = HEALTHY, Amber = RATE_LIMITED, Red = AUTH_ERROR or UNREACHABLE
- **Badge colors:** Match dot — "Healthy" on green bg, "Rate limited" on amber bg, "Unreachable" on red bg
- Cards use `var(--color-background-primary)` with `0.5px solid var(--color-border-tertiary)` border and `var(--border-radius-lg)` corners
- Do NOT use drop shadows
- The currently active provider (the one being used right now) gets a `2px solid var(--color-border-info)` border accent

#### Section 3 — Switch log table
A clean table with these columns:
```
Time | From provider | From model | To provider | To model | Reason | Attempt | Duration
```

- Show last 50 entries, newest first
- "From" provider in coral/red tones, "To" provider in green/teal tones — use `var(--color-background-danger)` and `var(--color-background-success)` on the pill badges
- Reason codes displayed as human-readable labels: "Rate limited (429)", "Service unavailable (503)", "Timeout"
- Attempt column shows "1st", "2nd", "3rd" with color coding (green → amber → red)
- Paginate at 25 rows with Previous/Next buttons
- Show "No switches recorded yet" empty state with a checkmark icon when log is empty

#### Section 4 — Configuration panel
A settings card at the bottom:
```
┌──────────────────────────────────────────────┐
│ Failover configuration                        │
│                                              │
│ Health check interval   [  300  ] seconds    │
│ Max retries per request [   3   ]            │
│ Delay after attempt 1   [ 2000  ] ms         │
│ Delay after attempt 2   [ 5000  ] ms         │
│ Alert on provider switch [ toggle ]           │
│                                              │
│                           [Save settings]    │
└──────────────────────────────────────────────┘
```

All inputs are number inputs with sensible min/max validation. Save button calls a PATCH endpoint to update `failover_config` in the database.

#### Data loading
- Use `React Query` or `SWR` (whichever the project already uses) to poll the status endpoint every 30 seconds automatically
- Show a small "Last updated X seconds ago" timestamp that ticks up in real time
- Show a pulsing green dot next to "Live" when polling is active

#### API routes for the admin page

Create these API routes (adapt path structure to match existing routes in the project):

```
GET  /api/admin/providers/status       → returns all provider statuses from provider_status table
GET  /api/admin/providers/switches     → returns paginated switch log
PATCH /api/admin/providers/config      → updates failover_config entries
POST  /api/admin/providers/failover-toggle → toggles failover_enabled on/off
POST  /api/admin/providers/health-check-now → manually triggers health check immediately
```

Protect ALL admin routes with the same auth middleware/guard that protects other existing admin routes. Do not invent a new auth system.

---

## IMPLEMENTATION SEQUENCE

Follow this exact order. Do not skip steps:

```
Step 1 — Read all existing files listed in CONTEXT SCAN above
Step 2 — Create provider_status, provider_switch_log, failover_config tables/schema
Step 3 — Run DB migration
Step 4 — Create lib/provider-failover/engine.ts with full failover logic
Step 5 — Create /api/cron/provider-health route
Step 6 — Inject failover wrapper into the ONE existing provider call site (surgical edit)
Step 7 — Create admin API routes (status, switches, config, toggle, health-check-now)
Step 8 — Create the admin dashboard page (app/admin/provider-failover/page.tsx)
Step 9 — Add nav link to the new admin page in the existing admin navigation (if one exists)
Step 10 — Test: manually trigger a 429 scenario to verify the retry + switch flow works
Step 11 — Verify all EXISTING routes and functionality still work identically
```

---

## ERROR HANDLING REQUIREMENTS

The failover engine must never crash the application. Wrap all database writes in try/catch — if the log write fails, still return the successful AI response. Log all errors to `console.error` with a `[ProviderFailover]` prefix for easy debugging.

```typescript
// Pattern to use for all DB writes in the engine:
try {
  await db.providerSwitchLog.create({ data: switchEvent })
} catch (dbErr) {
  console.error('[ProviderFailover] Failed to log switch event:', dbErr)
  // Never throw — always continue
}
```

---

## TESTING CHECKLIST

After implementation, verify each item works:

```
□ Normal request goes through without touching failover logic
□ Simulated 429 on provider A → 3 retries → switches to provider B → logs the switch
□ Provider B also rate-limited → tries provider C → logs second switch
□ All providers rate-limited → returns clear error message to user
□ Health check runs and updates provider_status table
□ Admin page loads and shows real provider statuses
□ Toggle switch enables/disables failover (check failover_config.failover_enabled)
□ Switch log table shows entries after triggering failover
□ Configuration save updates values in DB and engine picks them up
□ "Run health check now" button triggers immediate check and refreshes UI
□ All existing pages, routes, and features work exactly as before
□ No TypeScript errors in new files
□ No console errors in browser on admin page
```

---

## DO NOT DO ANY OF THE FOLLOWING

```
❌ Do not wrap ALL provider calls — only wrap the primary one identified in Step 1
❌ Do not change the shape of existing API responses
❌ Do not add failover logic to health check itself (infinite loop risk)
❌ Do not store API keys in the database (use existing env vars only)
❌ Do not create a separate provider management UI — only the failover monitoring dashboard
❌ Do not use polling intervals faster than 30 seconds in the admin UI
❌ Do not modify existing admin pages — only add the new page and a nav link
❌ Do not use localStorage for any failover state — database only
❌ Do not add any AI provider that doesn't have an existing API key in .env
```

---

## OUTPUT WHEN DONE

After completing all steps, show me:

1. The list of every file you created (new files only)
2. The list of every file you edited (showing only the diff/changed lines)
3. The URL path to the new admin dashboard page
4. How to manually trigger a test 429 to verify the failover works
5. Any environment variables that need to be added to `.env`
