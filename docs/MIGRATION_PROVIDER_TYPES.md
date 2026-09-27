# Migration Guide: Provider Types Update

This guide explains the new provider types feature and how it affects existing installations.

## What Changed?

We've added support for multiple provider types beyond generic OpenAI-compatible APIs. The first new provider type is **Databricks**.

### New Features

1. **Provider Type Selector** — When adding or editing a provider, you can now select the provider type from a dropdown
2. **Provider-Specific Configuration** — Different providers can have tailored UI hints and validation
3. **Backward Compatibility** — All existing providers automatically default to `openai` type

## For Existing Users

### ✅ No Action Required

If you have an existing installation with configured providers:

- **All existing providers will continue to work without changes**
- They will automatically be treated as `openai` type (generic OpenAI-compatible)
- No data migration or reconfiguration needed
- Your existing `.blueclaude-data/providers.json` file is forward-compatible

### Verification (Optional)

If you want to verify your existing providers:

1. Open the admin dashboard: `http://localhost:8787/admin`
2. Navigate to the **Providers** tab
3. Click **Edit** on any provider
4. You'll see the new "API Provider" dropdown — it will be set to "OpenAI Compatible"
5. Click **Cancel** (no need to save unless you want to change something)

### Upgrading

To update to the latest version:

```bash
# Pull the latest code
git pull origin main

# Install any new dependencies (if any)
npm install

# Rebuild
npm run build

# Restart the service
npm start
# or
pm2 restart fcc-gateway
# or
docker-compose restart
```

## For New Users

When adding a new provider:

1. Navigate to **Admin Dashboard → Providers**
2. Click **Add Provider**
3. Fill in the form:
   - **Provider Name**: Your choice (e.g., "My Databricks", "Kimi AI")
   - **API Provider**: Select from dropdown:
     - `OpenAI Compatible` — Generic OpenAI-compatible API (default)
     - `Databricks` — Databricks AI Gateway
   - **Base URL**: The API endpoint
   - **API Key**: Your access token
   - **Default Model**: The model name to use
4. Click **Test Connection** to verify
5. Click **Save Provider**

## Provider Types Explained

### OpenAI Compatible (Default)

- Use this for any generic OpenAI-compatible API
- Providers like Kimi, DeepSeek, OpenRouter, Mistral, Groq, etc.
- Base URL format: `https://api.provider.com/v1`
- Standard OpenAI API format for requests and responses

### Databricks

- Use this specifically for Databricks AI Gateway / Serving Endpoints
- Base URL format: `https://<workspace>.databricks.com/ai-gateway/mlflow/v1`
- Uses Databricks PAT token for authentication
- See [Databricks Setup Guide](DATABRICKS_SETUP.md) for details

## Technical Details

### Database Schema

The provider configuration now includes an optional `type` field:

```json
{
  "id": "my-provider",
  "name": "My Provider",
  "type": "openai",
  "baseUrl": "https://api.provider.com/v1",
  "apiKey": "sk-...",
  "defaultModel": "model-name",
  "notes": "",
  "createdAt": "2026-01-15T10:00:00.000Z"
}
```

### Backward Compatibility

- The `type` field is **optional**
- If not present, defaults to `openai`
- Existing installations with no `type` field will work without modification
- The TypeScript interfaces use `type?: string` (optional)

### Future Provider Types

More provider types may be added in the future, such as:
- Google Vertex AI
- AWS Bedrock
- Azure OpenAI
- Anthropic (direct)
- Custom enterprise gateways

Each provider type can have:
- Custom validation rules
- Provider-specific UI hints
- Tailored error messages
- Specialized request/response handling

## Troubleshooting

### Issue: Provider type dropdown is empty or not showing

**Solution:** Clear your browser cache and hard-reload the admin page (`Ctrl+Shift+R` or `Cmd+Shift+R`)

### Issue: Existing provider shows as "undefined" type

**Solution:** Edit the provider and save it again. It will automatically set the type to `openai`.

### Issue: TypeScript compilation errors after upgrade

**Solution:**
```bash
# Clean build artifacts
rm -rf dist/

# Reinstall dependencies
rm -rf node_modules/
npm install

# Rebuild
npm run build
```

## Support

If you encounter any issues:

1. Check the [Databricks Setup Guide](DATABRICKS_SETUP.md) if using Databricks
2. Review the main [README](../README.md) for general configuration
3. Open an issue on GitHub with:
   - Your provider type
   - Error messages from logs
   - Steps to reproduce

## Questions?

**Q: Do I need to reconfigure my existing providers?**  
A: No, they will continue working as-is.

**Q: Can I mix different provider types?**  
A: Yes! You can have multiple providers of different types and switch between them.

**Q: Does this change the API endpoints?**  
A: No, the `/v1/messages` and `/v1/chat/completions` endpoints work exactly the same.

**Q: Will more provider types be added?**  
A: Possibly, based on community demand and contribution.
