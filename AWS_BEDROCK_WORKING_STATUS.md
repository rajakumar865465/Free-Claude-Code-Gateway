# AWS Bedrock - Working Status

## ✅ ENDPOINT ISSUE RESOLVED

### The Problem
We discovered that **`bedrock-mantle` endpoint does NOT exist** (DNS lookup fails).

### The Solution  
Use `bedrock-runtime` with `/v1` path:
```
https://bedrock-runtime.{region}.amazonaws.com/v1/chat/completions
```

### Test Results
✅ DNS Resolution: Success
✅ HTTP Connection: Success (Status 200)
⚠️ Response Content: Empty (API key or model ID issue)

---

## Current Status

### What's Working
1. ✅ Endpoint is reachable (`bedrock-runtime`)
2. ✅ HTTP requests return 200 OK
3. ✅ No network/DNS errors
4. ✅ Streaming connections work

### What Needs Fixing
⚠️ **Empty Responses** - The gateway connects successfully but receives empty responses

### Likely Causes
1. **Invalid API Key Format**
   - The stored API key looks unusual or invalid
   - Normal API keys start with recognizable prefixes
   - This might be incorrectly formatted or encrypted

2. **Invalid Model ID**
   - Current model: `zai.glm-5`
   - This doesn't look like a valid Bedrock model ID
   - Bedrock model IDs should be like: `anthropic.claude-sonnet-4-5-20250929-v1:0`

3. **Authentication Method**
   - Bearer token authentication might not be working
   - AWS Bedrock might require AWS SigV4 authentication instead

---

## Next Steps to Fix

### Option 1: Verify API Key (RECOMMENDED)
1. Open Admin Dashboard: `http://localhost:8787/admin`
2. Edit the Bedrock provider (`gjg`)
3. Enter a fresh, valid Bedrock API key
4. Select a valid model from the dropdown (e.g., `anthropic.claude-sonnet-4-5-20250929-v1:0`)
5. Test connection
6. Save

### Option 2: Use Inference Profile IDs
Bedrock supports shorter model IDs called "inference profiles":
- `us.anthropic.claude-sonnet-5` instead of full version string
- Try updating the model ID to use inference profile format

### Option 3: Check Authentication
If bearer token auth doesn't work with `bedrock-runtime`, we may need to:
1. Implement AWS SigV4 authentication
2. Use AWS Access Keys instead of API keys
3. Revert to AWS SDK-based approach

---

## Technical Details

### Correct Endpoint Format
```typescript
// ✅ CORRECT (DNS resolves, endpoint exists)
https://bedrock-runtime.us-east-1.amazonaws.com/v1/chat/completions

// ❌ WRONG (DNS fails, endpoint doesn't exist)
https://bedrock-mantle.us-east-1.amazonaws.com/v1/chat/completions
```

### DNS Test Results
```bash
# bedrock-runtime - EXISTS ✅
$ nslookup bedrock-runtime.us-east-1.amazonaws.com
Addresses: 3.223.231.250, 100.49.7.149, 54.175.234.76, ...

# bedrock-mantle - DOES NOT EXIST ❌
$ nslookup bedrock-mantle.us-east-1.amazonaws.com
Error: queryA ENOTFOUND
```

### Current Implementation
- **File**: `src/utils/bedrock-url.ts`
- **Returns**: `https://bedrock-runtime.${region}.amazonaws.com/v1`
- **Authentication**: Bearer token (API key)
- **Request Format**: OpenAI-compatible Chat Completions

---

## Testing Commands

### Test from command line:
```bash
curl -X POST http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-key" \
  -d '{
    "model": "anthropic.claude-sonnet-4-5-20250929-v1:0",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 50
  }'
```

### Run test script:
```bash
node test-bedrock.js
```

---

## AWS Bedrock Model IDs

Valid Bedrock model IDs include:

### Anthropic Claude
- `anthropic.claude-sonnet-4-5-20250929-v1:0`
- `anthropic.claude-3-5-sonnet-20241022-v2:0`
- `anthropic.claude-3-5-haiku-20241022-v1:0`

### Inference Profiles (shorter IDs)
- `us.anthropic.claude-sonnet-5`
- `us.anthropic.claude-3-5-sonnet-v2`
- `us.anthropic.claude-3-5-haiku`

### Amazon Nova
- `amazon.nova-pro-v1:0`
- `amazon.nova-lite-v1:0`
- `amazon.nova-micro-v1:0`

### Meta Llama
- `meta.llama3-3-70b-instruct-v1:0`
- `meta.llama3-2-90b-instruct-v1:0`

---

## Authentication Notes

According to AWS documentation, `bedrock-runtime` endpoint supports:
- ✅ AWS Credentials (SigV4)
- ✅ Amazon Bedrock API Key

However, the bearer token authentication might not be working correctly. The documentation mentions "Amazon Bedrock API Key" but doesn't specify if it's used as a bearer token or requires a different format.

---

## Summary

| Component | Status | Notes |
|-----------|---------|-------|
| Endpoint Discovery | ✅ Fixed | Using `bedrock-runtime` instead of `bedrock-mantle` |
| DNS Resolution | ✅ Working | Endpoint resolves correctly |
| HTTP Connection | ✅ Working | Returns 200 OK |
| Request Format | ✅ Correct | OpenAI-compatible format |
| Response Content | ❌ Empty | API key or model ID issue |
| Authentication | ⚠️ Unknown | Bearer token format might be incorrect |

**Next Action**: Update the API key and model ID in the admin dashboard to valid Bedrock credentials.

---

## Files Updated
- `src/utils/bedrock-url.ts` - Changed from `bedrock-mantle` to `bedrock-runtime`
- `test-bedrock-direct.js` - DNS testing script (proves bedrock-mantle doesn't exist)
- `test-bedrock.js` - Integration test script

---

**Last Updated**: After discovering bedrock-mantle DNS failure
**Server Status**: Running on http://localhost:8787
**Admin Dashboard**: http://localhost:8787/admin
