# Databricks Provider Setup Guide

This guide explains how to configure the Bluesminds Claude Proxy to work with Databricks AI Gateway.

## Overview

Databricks provides an AI Gateway (formerly MLflow Gateway) that offers OpenAI-compatible endpoints for various LLM models. The proxy now supports Databricks as a first-class provider type.

## Prerequisites

- A Databricks workspace
- Access to Databricks AI Gateway / Serving Endpoints
- A Databricks personal access token (PAT)

## Configuration Steps

### 1. Get Your Databricks Credentials

1. Log into your Databricks workspace
2. Navigate to **User Settings** → **Access Tokens**
3. Generate a new personal access token (PAT)
4. Save the token securely (format: `dapi...`)

### 2. Find Your AI Gateway Endpoint

Your Databricks AI Gateway URL follows this pattern:

```
https://<workspace-url>/serving-endpoints/v1
```

Or for the newer AI Gateway endpoint:

```
https://<workspace-url>/ai-gateway/mlflow/v1
```

Example:
```
https://dbc-def4da34-c29a.cloud.databricks.com/ai-gateway/mlflow/v1
```

### 3. Add Databricks Provider in the Dashboard

1. Open the proxy admin dashboard: `http://localhost:8787/admin`
2. Navigate to the **Providers** tab
3. Click **Add Provider**
4. Fill in the form:
   - **Provider Name**: `Databricks` (or any name you prefer)
   - **API Provider**: Select `Databricks` from the dropdown
   - **Base URL**: Your Databricks AI Gateway endpoint (from step 2)
   - **API Key**: Your Databricks PAT token (from step 1)
   - **Default Model**: Your model name (e.g., `system.ai.glm-5-2` or other available models)
   - **Notes**: Optional notes about tier, pricing, etc.
5. Click **Test Connection** to verify the configuration
6. Click **Save Provider**
7. Click **Activate** to make this your active provider

### 4. Available Models

Common Databricks model names:
- `system.ai.glm-5-2` - GLM-5-2 model
- `databricks-meta-llama-3-70b-instruct` - Llama 3 70B
- `databricks-mixtral-8x7b-instruct` - Mixtral 8x7B
- Custom models deployed in your workspace

To see all available models:
1. Use the **Sync Models** button in the Providers tab
2. Or check your Databricks AI Gateway documentation

### 5. Model Mapping

After activating the Databricks provider, configure model mappings in the **Model Router** tab:

1. Navigate to **Model Router**
2. Map Claude model names to Databricks models:
   ```json
   {
     "claude-opus-4-5-20251101": "system.ai.glm-5-2",
     "claude-3-5-sonnet-latest": "system.ai.glm-5-2",
     "claude-sonnet-4-20250514": "databricks-meta-llama-3-70b-instruct"
   }
   ```
3. Click **Save Router**

## API Request Format

The Databricks provider uses the OpenAI-compatible format. A typical request looks like:

```bash
curl https://your-workspace.databricks.com/ai-gateway/mlflow/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $DATABRICKS_TOKEN" \
  -d '{
    "model": "system.ai.glm-5-2",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'
```

The proxy automatically handles this format when you select Databricks as the provider type.

## Troubleshooting

### Connection Test Fails

1. **401 Unauthorized**: Check that your PAT token is valid and has the correct permissions
2. **403 Forbidden**: Verify your account has access to the AI Gateway
3. **404 Not Found**: Confirm the base URL is correct and includes `/v1` path
4. **Timeout**: Check network connectivity to your Databricks workspace

### Model Not Found

1. Use **Sync Models** to refresh the available model list
2. Verify the model name exactly matches what's available in your workspace
3. Check that your account has permission to access the specific model

### Rate Limiting

Databricks enforces rate limits based on your workspace tier. If you encounter 429 errors:
- Reduce request frequency
- Upgrade your Databricks workspace tier
- Contact Databricks support for increased limits

## Multiple Provider Setup

You can configure multiple providers (e.g., Databricks + OpenAI + local models) and switch between them:

1. Add each provider in the Providers tab
2. Activate the one you want to use
3. Each provider maintains its own model mapping snapshot
4. Switch providers using the provider selector in the dashboard

## Environment Variable Configuration

Alternatively, you can configure Databricks in your `.env` file:

```env
PROVIDER_BASE_URL=https://dbc-def4da34-c29a.cloud.databricks.com/ai-gateway/mlflow/v1
PROVIDER_API_KEY=dapi...your-token...
DEFAULT_MODEL=system.ai.glm-5-2
```

## Support

For issues specific to:
- **Databricks AI Gateway**: Contact Databricks support or check their documentation
- **Proxy configuration**: Open an issue on the proxy GitHub repository
- **Model availability**: Check your Databricks workspace model catalog

## References

- [Databricks AI Gateway Documentation](https://docs.databricks.com/en/machine-learning/model-serving/index.html)
- [Databricks Personal Access Tokens](https://docs.databricks.com/en/dev-tools/auth/pat.html)
- [OpenAI API Compatibility](https://docs.databricks.com/en/machine-learning/model-serving/score-foundation-models.html)
