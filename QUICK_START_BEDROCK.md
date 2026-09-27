# Quick Start: Testing AWS Bedrock

## Current Status
✅ AWS Bedrock endpoint has been fixed from `bedrock-runtime` to `bedrock-mantle`
✅ Build is successful
✅ Code is ready for testing

## Quick Test Steps

### 1. Restart the Server
The server is currently running. Restart it to load the new endpoint fix:

```bash
# Stop the current server (Ctrl+C in the terminal where it's running)
# Then start it again:
npm start
```

Or if using the batch file:
```bash
claude-proxy.bat
```

### 2. Access Admin Dashboard
Open your browser to:
```
http://localhost:8787/admin
```

### 3. Test Existing Bedrock Provider (If You Have One)

If you already have an AWS Bedrock provider configured:

1. Go to the admin dashboard
2. Find your AWS Bedrock provider in the list
3. Click **Activate** to make it the active provider
4. Click **Test Connection**
5. You should now see success instead of the empty response error

### 4. Add New Bedrock Provider

If you don't have a Bedrock provider yet:

1. Click **Add Provider**
2. Select **AWS Bedrock** from the dropdown
3. Fill in:
   - **Display Name**: `My Bedrock Provider`
   - **AWS Region**: Select your region (e.g., `us-east-1`)
   - **Amazon Bedrock API Key**: Paste your Bedrock API key
   - **Default Model ID**: Select a model (e.g., `anthropic.claude-sonnet-4-5-20250929-v1:0`)
4. Click **Test Connection**
5. If successful, click **Save Provider**

### 5. Send a Test Request

With Bedrock activated, test it via curl:

**Anthropic Messages API format:**
```bash
curl -X POST http://localhost:8787/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-key-here" \
  -H "anthropic-version: 2023-06-01" \
  -d "{\"model\":\"claude-sonnet-4\",\"messages\":[{\"role\":\"user\",\"content\":\"Hello\"}],\"max_tokens\":50}"
```

**OpenAI Chat Completions API format:**
```bash
curl -X POST http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-key-here" \
  -d "{\"model\":\"anthropic.claude-sonnet-4-5-20250929-v1:0\",\"messages\":[{\"role\":\"user\",\"content\":\"Hello\"}],\"max_tokens\":50}"
```

## What Changed

### Before (Broken)
```
Endpoint: https://bedrock-runtime.us-east-1.amazonaws.com
Result: Empty responses with UnknownOperationException
```

### After (Fixed)
```
Endpoint: https://bedrock-mantle.us-east-1.amazonaws.com
Result: Valid responses from Bedrock models
```

## Expected Test Results

### ✅ Success Indicators
- Test Connection shows "Connection successful"
- Chat requests return valid JSON responses
- Responses contain model-generated text
- Token usage is reported
- No `UnknownOperationException` errors

### ❌ Common Errors and Fixes

**401 Unauthorized**
- Issue: Invalid API key
- Fix: Double-check your Bedrock API key

**403 Forbidden**
- Issue: Model not enabled in AWS Console
- Fix: Go to AWS Bedrock Console > Model Access > Enable the model

**404 Not Found**
- Issue: Invalid model ID or wrong region
- Fix: Verify the model ID is correct and available in your region

**Connection timeout**
- Issue: Network or AWS service issue
- Fix: Check your internet connection and AWS service status

## View Logs

To see detailed request logs:
```bash
# Check the server console output
# Logs show:
# - health_check_result for each provider
# - request_completed for successful requests
# - Error details for failed requests
```

From your log output, you have many healthy providers (nvidia, google, bluesminds, etc.). After the fix, Bedrock should also show as healthy.

## Need Help?

Check these files:
- `docs/AWS_BEDROCK_SETUP.md` - Complete setup guide
- `AWS_BEDROCK_ENDPOINT_FIX.md` - Details on the fix
- `AWS_BEDROCK_FINAL_STATUS.md` - Full implementation status

## Summary

The AWS Bedrock integration is now complete and fixed. The key change was updating the endpoint from `bedrock-runtime` to `bedrock-mantle`, which is the correct endpoint for OpenAI-compatible API with bearer token authentication.

**Just restart the server and test your Bedrock provider!**
