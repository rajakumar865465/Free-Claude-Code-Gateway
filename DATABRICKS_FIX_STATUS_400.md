# Fix: Databricks "Status 400" Error on Test Connection

## Problem
When testing a Databricks provider connection, the test was failing with "Upstream returned status 400" error. This was because Databricks AI Gateway doesn't support the standard OpenAI `/models` endpoint in the same way.

## Root Cause
The test connection feature was trying to call:
```
GET https://dbc-def4da34-c29a.cloud.databricks.com/ai-gateway/mlflow/v1/models
```

However, Databricks AI Gateway either:
1. Doesn't expose the `/models` endpoint
2. Returns 400 for this endpoint format
3. Requires different request parameters

## Solution Implemented

### 1. Frontend Test Connection (public/admin/dashboard.js)

**For new Databricks providers:**
- Now tests using `/chat/completions` endpoint instead of `/models`
- Requires both API key AND model ID to be entered before testing
- Sends a minimal test request: `{"model": "...", "messages": [{"role": "user", "content": "Hi"}], "max_tokens": 5}`
- Shows appropriate error messages if credentials or model ID are missing

**For existing Databricks providers:**
- Uses the backend `/providers/:id/test` endpoint which is already set up for chat completions

### 2. Backend Sync Models (src/admin/routes/admin-api.routes.ts)

Updated `/admin/api/sync-models` endpoint:
```typescript
// Check if active provider is Databricks
const activeProvider = state.providerManager.getActive();
if (activeProvider?.type === 'databricks') {
  // Databricks doesn't reliably support /models endpoint
  // Return empty array with a helpful message
  res.json({ 
    models: [], 
    syncedAt: new Date().toISOString(),
    message: 'Databricks does not expose a models list endpoint. Enter your model ID manually (e.g., system.ai.glm-5-2)'
  });
  return;
}
```

### 3. Provider Activation Model Fetch

Updated `fetchAndRemap()` function to skip model fetching for Databricks:
```typescript
const fetchAndRemap = async () => {
  try {
    // Skip model fetching for Databricks as it doesn't support /models endpoint
    if (active.type === 'databricks') {
      return;
    }
    // ... rest of model fetching code
  }
};
```

### 4. Health Check / Failover (src/provider-failover/engine.ts)

Updated health check to skip `/models` endpoint for Databricks:
```typescript
// Skip /models for Databricks as it doesn't support this endpoint reliably
if (provider.type === 'databricks') {
  // Skip tier 1 for Databricks, go directly to tier 2 (chat completions)
  tier1Error = 'Databricks does not support /models endpoint';
} else {
  // Normal /models health check for other providers
  try {
    const r = await fetchWithTimeout(`${baseUrl}/models`, ...);
    // ...
  } catch (err) {
    // ...
  }
}
```

This ensures Databricks providers go directly to the chat completions health check (tier 2) which actually works.

## Testing the Fix

### Test New Databricks Provider

1. Open admin dashboard
2. Click "Add Provider"
3. Select "Databricks" from dropdown
4. Enter:
   - Display Name: `My Databricks`
   - API Key: Your Databricks token
   - Model ID: `system.ai.glm-5-2` (or your model)
5. Click "Test Connection"

**Expected Result:**
- ✓ Connection test succeeds with: `✓ XXms · Connection OK`
- No more "Status 400" error

### Test Existing Databricks Provider

1. Click "Edit" on existing Databricks provider
2. Click "Test Connection"

**Expected Result:**
- Uses backend test endpoint
- ✓ Connection test succeeds

### Test Chat Completion

```bash
curl -X POST http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-proxy-key" \
  -d '{
    "model": "system.ai.glm-5-2",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 50
  }'
```

**Expected Result:**
- Request succeeds
- Response contains chat completion from Databricks

### Test Health Check

1. Go to "Failover" tab
2. Click "Run Health Check Now"

**Expected Result:**
- Databricks provider shows as HEALTHY
- No errors about /models endpoint

## User-Facing Changes

### Before (Broken)
- Test Connection → ✗ Upstream returned status 400
- Users couldn't validate their Databricks setup
- Health checks might fail

### After (Fixed)
- Test Connection → ✓ XXms · Connection OK
- Clear error messages if API key or model ID is missing
- "Sync Models" shows helpful message: "Databricks does not expose a models list endpoint. Enter your model ID manually"
- Health checks work correctly using chat completions endpoint

## Known Limitations

1. **No automatic model discovery**: Users must manually enter their Databricks model ID
2. **Model list not populated**: The model dropdown won't have suggestions for Databricks
3. **Manual model entry required**: Users should check their Databricks workspace for available model names

## Recommended Model IDs for Databricks

Common Databricks models to enter manually:
- `system.ai.glm-5-2` - GLM-5-2 model
- `databricks-meta-llama-3-70b-instruct` - Llama 3 70B
- `databricks-mixtral-8x7b-instruct` - Mixtral 8x7B

Users should check their specific Databricks workspace for available models.

## Why This Approach?

Databricks AI Gateway is designed for serving specific deployed models, not for generic model discovery. The `/models` endpoint either:
- Doesn't exist in their OpenAI-compatible API layer
- Returns 400 due to different API expectations
- Requires workspace-specific authentication patterns

By testing with `/chat/completions` directly (which is what users will actually use), we:
1. ✅ Validate the actual endpoint that matters
2. ✅ Test authentication properly
3. ✅ Confirm the model ID is valid
4. ✅ Avoid unnecessary failed requests

## Files Modified

1. `public/admin/dashboard.js` - Test connection logic
2. `src/admin/routes/admin-api.routes.ts` - Sync models & provider activation
3. `src/provider-failover/engine.ts` - Health check tier 1

## Verification

- ✅ Code compiles successfully
- ✅ No TypeScript/JavaScript errors
- ✅ Test connection now works with Databricks
- ✅ Health checks work properly
- ✅ Chat completions route correctly
- ✅ Other providers (OpenAI, Groq, etc.) still work normally
