# Provider Types Guide

This guide explains the different provider types available in the Bluesminds Claude Proxy and how to configure them.

## Overview

The proxy now supports multiple provider types, each with its own configuration requirements:

1. **OpenAI Compatible** - Custom OpenAI-compatible endpoints (default)
2. **Databricks** - Databricks AI Gateway / Serving Endpoints
3. **OpenAI** - Official OpenAI API (built-in)
4. **Anthropic** - Official Anthropic API (built-in)
5. **Google Gemini** - Google Gemini API (built-in)
6. **Groq** - Groq Cloud API (built-in)
7. **OpenRouter** - OpenRouter aggregation service (built-in)

## Provider Type: OpenAI Compatible

### When to Use
Use this for any custom OpenAI-compatible API endpoint that isn't covered by the built-in providers. This includes:
- Kimi / MoonShot API
- DeepSeek API
- GLM / Z.ai API
- Custom self-hosted APIs (vLLM, llama.cpp, etc.)
- Any other OpenAI-compatible service

### Configuration

1. **Select Provider Type**: OpenAI Compatible
2. **Provider Name**: Your choice (e.g., "Kimi AI", "My Custom API")
3. **Base URL**: The OpenAI-compatible endpoint URL
   - **Default prefill**: `https://dbc-def4da34-c29a.cloud.databricks.com/ai-gateway/mlflow/v1`
   - **Editable**: Yes, replace with your actual endpoint
   - **Format**: Must start with `http://` or `https://`
   - **Path**: Must include `/v1` if required by your provider
4. **API Key**: Your provider's API key
5. **Default Model**: The model name to use (e.g., `kimi-k2.6`, `deepseek-chat`)

### Example Configuration

```
Provider Type: OpenAI Compatible
Provider Name: Kimi AI
Base URL: https://api.moonshot.cn/v1
API Key: sk-abc123...
Default Model: kimi-k2.6
```

### URL Processing

The proxy will:
- Remove any trailing slashes from your Base URL
- Append the appropriate API path (e.g., `/chat/completions`)
- Construct the final endpoint: `{baseUrl}/chat/completions`

**Example:**
- You enter: `https://api.moonshot.cn/v1/`
- Saved as: `https://api.moonshot.cn/v1`
- Final API call: `https://api.moonshot.cn/v1/chat/completions`

This prevents duplicate path issues like `/v1/v1/chat/completions`.

### Validation Rules

- Base URL is **required** for OpenAI Compatible providers
- Must start with `http://` or `https://`
- Trailing slashes are automatically removed
- Cannot be empty or contain only whitespace

## Provider Type: Databricks

### When to Use
Use this specifically for Databricks AI Gateway or Serving Endpoints.

### Configuration

1. **Select Provider Type**: Databricks
2. **Provider Name**: Your choice (e.g., "My Databricks Workspace")
3. **Databricks Workspace URL**: Your workspace base URL
   - **Format**: `https://<workspace-id>.cloud.databricks.com`
   - **Example**: `https://dbc-abc123-def4.cloud.databricks.com`
4. **API Key**: Your Databricks personal access token (PAT)
5. **Default Model**: Databricks model name (e.g., `system.ai.glm-5-2`)

### Auto-Generated Base URL

The proxy automatically generates the full AI Gateway endpoint:

```
Workspace URL: https://dbc-abc123-def4.cloud.databricks.com
        ↓
Base URL: https://dbc-abc123-def4.cloud.databricks.com/ai-gateway/mlflow/v1
```

You don't need to manually construct the gateway path - it's added automatically.

### Example Configuration

```
Provider Type: Databricks
Provider Name: Production Databricks
Databricks Workspace URL: https://dbc-def4da34-c29a.cloud.databricks.com
API Key: dapi...
Default Model: system.ai.glm-5-2
```

## Built-In Providers

### OpenAI, Anthropic, Google Gemini, Groq, OpenRouter

These providers are built-in and **do not require a Base URL**.

### Configuration

1. **Select Provider Type**: (e.g., OpenAI, Anthropic, etc.)
2. **Provider Name**: Your choice
3. **API Key**: Your provider's API key
4. **Default Model**: The model name (e.g., `gpt-4o`, `claude-3-opus`)

**Note:** The Base URL field is completely hidden for built-in providers. The proxy uses predefined endpoints internally.

### Example: OpenAI Configuration

```
Provider Type: OpenAI
Provider Name: OpenAI Official
API Key: sk-proj-...
Default Model: gpt-4o
```

The proxy automatically uses `https://api.openai.com/v1` internally.

## Field Visibility Rules

| Provider Type | Base URL Field | Databricks Workspace Field |
|---|---|---|
| OpenAI Compatible | ✅ Visible & Required | ❌ Hidden |
| Databricks | ❌ Hidden | ✅ Visible & Required |
| OpenAI | ❌ Hidden | ❌ Hidden |
| Anthropic | ❌ Hidden | ❌ Hidden |
| Google Gemini | ❌ Hidden | ❌ Hidden |
| Groq | ❌ Hidden | ❌ Hidden |
| OpenRouter | ❌ Hidden | ❌ Hidden |

## Switching Between Provider Types

### Scenario 1: OpenAI Compatible → Built-In Provider

1. You configure OpenAI Compatible with a custom Base URL
2. You switch to "OpenAI" (built-in)
3. **Result**: 
   - Base URL field disappears
   - Your custom URL is saved in memory for this session
   - Built-in OpenAI endpoints are used instead

### Scenario 2: Built-In Provider → OpenAI Compatible

1. You're using a built-in provider (no Base URL shown)
2. You switch to "OpenAI Compatible"
3. **Result**:
   - Base URL field appears
   - Prefilled with the default Databricks URL or your last saved custom URL
   - You can edit or replace it

### Scenario 3: Editing an Existing Provider

When you edit a provider:
- The provider type is preserved
- The appropriate fields are shown/hidden based on the type
- For OpenAI Compatible providers, the saved Base URL is displayed
- For Databricks providers, the workspace URL is extracted and displayed

## URL Memory Feature

The UI remembers your last custom OpenAI-compatible URL within a session:

1. You enter `https://api.custom-provider.com/v1`
2. You switch to a built-in provider
3. You switch back to OpenAI Compatible
4. **Result**: Your custom URL `https://api.custom-provider.com/v1` is restored

If you haven't entered a custom URL yet, the default Databricks URL is used as the prefill.

## Validation and Error Handling

### Base URL Validation (OpenAI Compatible)

✅ **Valid URLs:**
```
https://api.moonshot.cn/v1
http://localhost:1234/v1
https://my-custom-api.example.com/openai/v1
```

❌ **Invalid URLs:**
```
api.moonshot.cn/v1              (missing protocol)
ftp://api.moonshot.cn/v1        (invalid protocol)
                                (empty/whitespace)
```

### Error Messages

- **Missing Base URL**: "Base URL is required for OpenAI Compatible providers."
- **Invalid Protocol**: "Base URL must start with http:// or https://"
- **Missing Workspace URL**: "Databricks Workspace URL is required."

Errors are displayed:
- In a red error message below the field
- As a toast notification
- Inline validation on blur (when you click away from the field)

## Testing Connections

### For OpenAI Compatible Providers

The "Test Connection" button will:
1. Use your entered Base URL
2. Call `{baseUrl}/models` to fetch available models
3. Display latency and model count on success
4. Show error details on failure

### For Databricks Providers

The "Test Connection" button will:
1. Auto-generate the full Base URL from your workspace URL
2. Call the Databricks AI Gateway `/models` endpoint
3. Display connection status and available models

### For Built-In Providers

Testing from the modal requires the provider to be activated first. The test button will show an info message directing you to activate the provider.

## API Request Flow

### OpenAI Compatible

```
User Request
    ↓
Proxy receives request
    ↓
Reads provider config
    ↓
Uses custom Base URL: https://api.moonshot.cn/v1
    ↓
Appends path: /chat/completions
    ↓
Final request: https://api.moonshot.cn/v1/chat/completions
    ↓
Provider responds
    ↓
Proxy returns response
```

### Databricks

```
User Request
    ↓
Proxy receives request
    ↓
Reads provider config
    ↓
Uses auto-generated Base URL: https://workspace.databricks.com/ai-gateway/mlflow/v1
    ↓
Appends path: /chat/completions
    ↓
Final request: https://workspace.databricks.com/ai-gateway/mlflow/v1/chat/completions
    ↓
Databricks responds
    ↓
Proxy returns response
```

### Built-In Providers

```
User Request
    ↓
Proxy receives request
    ↓
Reads provider config (type: openai, anthropic, etc.)
    ↓
Uses predefined internal endpoint
    ↓
Proxy routes to appropriate built-in provider
    ↓
Provider responds
    ↓
Proxy returns response
```

## Migration from Previous Versions

If you have providers from previous versions:
- They will default to `openai-compatible` type
- Their existing Base URLs are preserved
- No manual migration needed
- Edit and save to update the provider type if needed

## Best Practices

1. **Use Built-In Providers When Possible**: If you're using OpenAI, Anthropic, etc., select the built-in provider type instead of OpenAI Compatible. This ensures optimal routing and configuration.

2. **Test Connections**: Always use "Test Connection" before saving a new provider to verify your configuration is correct.

3. **Include /v1 Path**: Most OpenAI-compatible providers require `/v1` in the Base URL. Check your provider's documentation.

4. **Remove Trailing Slashes**: The proxy does this automatically, but it's good practice to enter clean URLs without trailing slashes.

5. **Use Descriptive Names**: Give your providers clear names like "Production Databricks" or "Kimi AI - Free Tier" to easily identify them.

6. **Secure API Keys**: Never share your API keys. They are stored locally and never sent to the browser in full.

## Troubleshooting

### Issue: Base URL field is not showing

**Solution**: Make sure you selected "OpenAI Compatible" as the provider type. Built-in providers don't show this field.

### Issue: Test Connection fails with "Invalid URL"

**Solution**: 
- Verify the URL starts with `http://` or `https://`
- Check for typos in the domain name
- Ensure the `/v1` path is included if required

### Issue: API calls result in 404 errors

**Possible causes**:
- Missing `/v1` path in Base URL
- Incorrect provider endpoint
- Provider type mismatch

**Solution**: Check your provider's documentation for the correct endpoint format.

### Issue: Saved provider has wrong Base URL

**Solution**: Edit the provider and verify the Base URL field. Make sure you're using the correct provider type.

## Support

For additional help:
- Check the main [README](../README.md) for general setup
- See [Databricks Setup Guide](DATABRICKS_SETUP.md) for Databricks-specific configuration
- Open an issue on GitHub with your provider type and error details
