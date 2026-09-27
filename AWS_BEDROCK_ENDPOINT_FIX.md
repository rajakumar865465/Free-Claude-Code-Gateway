# AWS Bedrock Endpoint Fix

## Issue
AWS Bedrock responses were empty with error `"com.amazon.coral.service#UnknownOperationException"`. The root cause was using the wrong endpoint URL.

## Root Cause
- **Previous endpoint**: `https://bedrock-runtime.{region}.amazonaws.com`
- **Correct endpoint**: `https://bedrock-mantle.{region}.amazonaws.com`

According to AWS documentation, the `bedrock-mantle` endpoint is the correct endpoint for OpenAI-compatible Chat Completions API with API key (bearer token) authentication.

## Changes Made

### 1. Updated Endpoint Construction (`src/utils/bedrock-url.ts`)
**Changed from:**
```typescript
return `https://bedrock-runtime.${region}.amazonaws.com`;
```

**Changed to:**
```typescript
return `https://bedrock-mantle.${region}.amazonaws.com`;
```

### 2. Updated Documentation Reference
Updated the comment reference from generic model-parameters page to the specific chat-completions-api documentation.

### 3. Updated Setup Guide (`docs/AWS_BEDROCK_SETUP.md`)
Updated the "Testing the Connection" section to reflect:
- Correct `bedrock-mantle` endpoint
- Added note explaining this is the recommended endpoint for OpenAI-compatible API

## Testing

### Build Status
✅ TypeScript compilation successful with no errors

### Expected Behavior
After this fix, AWS Bedrock requests should:
1. Successfully reach the correct OpenAI-compatible endpoint
2. Receive valid responses from Bedrock models
3. Support chat completions, streaming, and all OpenAI-compatible features

### Test Connection Endpoint
The gateway now tests Bedrock connections using:
```
POST https://bedrock-mantle.{region}.amazonaws.com/chat/completions
Authorization: Bearer {api-key}
```

## Files Modified
1. `src/utils/bedrock-url.ts` - Endpoint construction utility
2. `docs/AWS_BEDROCK_SETUP.md` - Updated documentation

## Next Steps

To test the fix:

1. **Start the server**:
   ```bash
   npm start
   ```

2. **Open Admin Dashboard**:
   ```
   http://localhost:8787/admin
   ```

3. **Add/Edit AWS Bedrock provider**:
   - Select AWS Region (e.g., `us-east-1`)
   - Enter your Bedrock API Key
   - Enter a valid Model ID (e.g., `anthropic.claude-sonnet-4-5-20250929-v1:0`)

4. **Click "Test Connection"**:
   - Should now return success instead of empty response
   - Should show "Connection successful" message

5. **Test actual requests**:
   - Send a chat completion request to `/v1/messages` or `/v1/chat/completions`
   - Should receive valid responses from Bedrock models

## Reference
- AWS Bedrock Chat Completions API: https://docs.aws.amazon.com/bedrock/latest/userguide/chat-completions-api.html
- AWS Bedrock Model IDs: https://docs.aws.amazon.com/bedrock/latest/userguide/model-ids.html
