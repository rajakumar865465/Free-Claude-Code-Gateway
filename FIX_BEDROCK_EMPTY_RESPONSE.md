# Fix AWS Bedrock Empty Response

## Current Situation
✅ Gateway connects to AWS Bedrock successfully (200 OK)
❌ Responses are empty (no content)

## Root Cause
The API key or model ID in your Bedrock provider is incorrect.

Looking at your provider configuration:
- **API Key**: `YOUR_BEDROCK_API_KEY_HERE`
  - This doesn't match typical AWS API key formats
  - It looks like it might be base64 encoded or incorrectly formatted

- **Model ID**: `zai.glm-5`
  - This is NOT a valid AWS Bedrock model ID
  - Valid IDs look like: `anthropic.claude-sonnet-4-5-20250929-v1:0`

---

## How to Fix

### Step 1: Get a Valid Bedrock API Key

AWS Bedrock supports two authentication methods:

**Option A: API Key (Simpler)**
1. Go to AWS Console → Bedrock
2. Navigate to API Keys section
3. Create a new API key
4. Copy the key (starts with something recognizable)

**Option B: AWS Access Keys (More Common)**
If Bedrock doesn't provide simple API keys, you'll need:
1. AWS Access Key ID
2. AWS Secret Access Key
3. Use AWS SigV4 authentication

*Note: Our current implementation uses bearer token auth. If AWS Bedrock requires SigV4, we'll need to update the code.*

### Step 2: Update the Provider

#### Via Admin Dashboard (Recommended):
1. Open: http://localhost:8787/admin
2. Find your Bedrock provider (`gjg`)
3. Click **Edit**
4. Update these fields:
   - **API Key**: Enter your valid Bedrock API key
   - **Model ID**: Select from dropdown or enter:
     - `anthropic.claude-sonnet-4-5-20250929-v1:0`
     - Or inference profile: `us.anthropic.claude-sonnet-5`
5. Click **Test Connection**
6. If successful, click **Save**

#### Via JSON File (Alternative):
1. Stop the server
2. Edit: `.blueclaude-data/providers.json`
3. Find the `gjg` provider
4. Update:
   ```json
   {
     "id": "gjg",
     "name": "gjg",
     "type": "aws_bedrock",
     "baseUrl": "",
     "apiKey": "YOUR_REAL_BEDROCK_API_KEY",
     "defaultModel": "anthropic.claude-sonnet-4-5-20250929-v1:0",
     "awsRegion": "us-east-1",
     ...
   }
   ```
5. Restart the server

---

## Valid Bedrock Model IDs

### Anthropic Claude Models
```
anthropic.claude-sonnet-4-5-20250929-v1:0
anthropic.claude-3-5-sonnet-20241022-v2:0
anthropic.claude-3-5-haiku-20241022-v1:0
anthropic.claude-3-opus-20240229-v1:0
```

### Inference Profiles (Shorter IDs)
```
us.anthropic.claude-sonnet-5
us.anthropic.claude-3-5-sonnet-v2
us.anthropic.claude-3-5-haiku
eu.anthropic.claude-sonnet-5  (for EU regions)
```

### Amazon Nova
```
amazon.nova-pro-v1:0
amazon.nova-lite-v1:0
amazon.nova-micro-v1:0
```

### Other Providers
```
meta.llama3-3-70b-instruct-v1:0
mistral.mistral-large-2407-v1:0
cohere.command-r-plus-v1:0
```

---

## Testing After Fix

### 1. Test Connection in Dashboard
- Should show "Connection successful" or list of models
- Should NOT show authentication errors

### 2. Test via curl
```bash
curl -X POST http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic.claude-sonnet-4-5-20250929-v1:0",
    "messages": [{"role": "user", "content": "Say hello"}],
    "max_tokens": 50
  }'
```

Expected response:
```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "anthropic.claude-sonnet-4-5-20250929-v1:0",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Hello! How can I help you today?"
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 8,
    "total_tokens": 18
  }
}
```

### 3. Test via test script
```bash
node test-bedrock.js
```

Should show actual response content, not empty strings.

---

## If Still Not Working

### Check 1: Authentication Method
AWS Bedrock might NOT support simple bearer token auth. If you continue getting empty responses:

1. Check if the endpoint requires AWS SigV4 authentication
2. We may need to implement AWS SDK-based authentication
3. This would require using AWS Access Keys instead of API keys

### Check 2: Model Access
1. Go to AWS Bedrock Console
2. Check "Model Access" section
3. Ensure the model you're trying to use is enabled
4. Some models require requesting access

### Check 3: Region Availability
Not all models are available in all regions:
- `us-east-1`: Most models available
- `us-west-2`: Most models available
- Other regions: Check availability in AWS Console

---

## Alternative: If Bearer Token Auth Doesn't Work

If AWS Bedrock doesn't support bearer token authentication for `bedrock-runtime`, we'll need to implement AWS SigV4 signing:

### Implementation Changes Needed:
1. Restore AWS SDK dependencies
2. Use AWS Access Key ID + Secret Access Key
3. Sign requests with SigV4
4. Update frontend to collect AWS credentials instead of API key

This would be a more significant change. Let's first verify if bearer token auth can work with the correct credentials.

---

## Quick Checklist

- [ ] Get valid Bedrock API key (or Access Keys)
- [ ] Update provider with correct API key
- [ ] Update provider with valid model ID (from list above)
- [ ] Test connection in admin dashboard
- [ ] Verify response is not empty
- [ ] Save provider configuration

---

## Need Help?

**Current Status**:
- Server running: http://localhost:8787
- Admin dashboard: http://localhost:8787/admin
- Bedrock provider ID: `gjg`
- Current endpoint: `https://bedrock-runtime.us-east-1.amazonaws.com/v1`

**Documentation**:
- `AWS_BEDROCK_WORKING_STATUS.md` - Detailed technical status
- `docs/AWS_BEDROCK_SETUP.md` - Setup guide
- `QUICK_START_BEDROCK.md` - Quick start guide

**Next Step**: Update the API key and model ID in the admin dashboard!
