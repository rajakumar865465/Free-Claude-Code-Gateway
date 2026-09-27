# Databricks Integration Test Guide

## Manual Testing Steps

### 1. Test Adding a New Databricks Provider

1. Start the proxy server: `npm start`
2. Open the admin dashboard: `http://localhost:8787/admin`
3. Click "Add Provider"
4. Select "Databricks" from the API Provider dropdown
5. **Verify**: No "Databricks Workspace URL" field is shown
6. **Verify**: No "Base URL" field is shown
7. Enter:
   - Display Name: `Test Databricks`
   - API Key: Your Databricks token
   - Model ID: `system.ai.glm-5-2` (or your available model)
8. Click "Test Connection"
9. **Expected**: Connection test uses `https://dbc-def4da34-c29a.cloud.databricks.com/ai-gateway/mlflow/v1/models`
10. **Expected**: Test succeeds if credentials are valid
11. Click "Save"
12. **Expected**: Provider is created without errors

### 2. Test Editing an Existing Databricks Provider

1. Click "Edit" on the Databricks provider you just created
2. **Verify**: No "Databricks Workspace URL" field is shown
3. **Verify**: No "Base URL" field is shown
4. Modify the Display Name or Notes
5. Click "Save"
6. **Expected**: Provider updates successfully

### 3. Test Chat Completion with Databricks

1. Set the Databricks provider as active
2. Send a test request via curl:

```bash
curl -X POST http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-proxy-api-key" \
  -d '{
    "model": "system.ai.glm-5-2",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 50
  }'
```

3. **Expected**: Request goes to `https://dbc-def4da34-c29a.cloud.databricks.com/ai-gateway/mlflow/v1/chat/completions`
4. **Expected**: No `/v1/v1` duplication in URL
5. **Expected**: Response is received successfully

### 4. Test Provider Health Check (Failover)

1. Go to admin dashboard "Failover" tab
2. Click "Run Health Check Now"
3. **Expected**: Databricks provider health check uses the fixed base URL
4. **Expected**: Status shows as HEALTHY if provider is working

### 5. Test Model Sync

1. With Databricks provider active, go to "Model Router" tab
2. Click "Sync Models from Active Provider"
3. **Expected**: Models are fetched from `https://dbc-def4da34-c29a.cloud.databricks.com/ai-gateway/mlflow/v1/models`
4. **Expected**: Available models are listed

### 6. Test Backward Compatibility (If you have old providers)

If you have an existing Databricks provider with an old workspace URL:

1. DO NOT edit or re-save the provider
2. Simply activate it
3. Send a chat completion request
4. **Expected**: Request uses the new fixed URL automatically
5. **Expected**: Request succeeds

### 7. Test Provider Type Switching

1. Click "Add Provider"
2. Select "OpenAI Compatible"
3. **Verify**: Base URL field IS shown
4. Switch to "Databricks"
5. **Verify**: Base URL field disappears
6. Switch to "Groq"
7. **Verify**: Base URL field is hidden
8. Switch back to "OpenAI Compatible"
9. **Verify**: Base URL field reappears

## Automated Test Ideas

```typescript
// Test that Databricks provider uses fixed URL
describe('Databricks Provider', () => {
  it('should use fixed base URL when adding Databricks provider', () => {
    const manager = new ProviderManager();
    const provider = manager.add({
      name: 'Test Databricks',
      type: 'databricks',
      apiKey: 'test-key',
      defaultModel: 'system.ai.glm-5-2',
      baseUrl: 'https://should-be-ignored.com' // This should be ignored
    });
    
    expect(provider.baseUrl).toBe('https://dbc-def4da34-c29a.cloud.databricks.com/ai-gateway/mlflow/v1');
  });

  it('should use fixed base URL when updating Databricks provider', () => {
    const manager = new ProviderManager();
    const provider = manager.add({
      name: 'Test Databricks',
      type: 'databricks',
      apiKey: 'test-key',
      defaultModel: 'system.ai.glm-5-2'
    });
    
    const updated = manager.update(provider.id, {
      baseUrl: 'https://different-url.com' // This should be ignored
    });
    
    expect(updated.baseUrl).toBe('https://dbc-def4da34-c29a.cloud.databricks.com/ai-gateway/mlflow/v1');
  });

  it('should use fixed base URL in ConfigManager', () => {
    const providerManager = new ProviderManager();
    const provider = providerManager.add({
      name: 'Test Databricks',
      type: 'databricks',
      apiKey: 'test-key',
      defaultModel: 'system.ai.glm-5-2'
    });
    providerManager.setActive(provider.id);
    
    const configManager = new ConfigManager(providerManager);
    const baseUrl = configManager.getBaseUrl();
    
    expect(baseUrl).toBe('https://dbc-def4da34-c29a.cloud.databricks.com/ai-gateway/mlflow/v1');
  });
});
```

## Success Criteria

- ✅ No workspace URL field appears for Databricks providers
- ✅ Fixed base URL is used automatically
- ✅ Test Connection works correctly
- ✅ Chat completions are routed to correct endpoint
- ✅ No `/v1/v1` URL duplication
- ✅ Health checks work properly
- ✅ Model sync works correctly
- ✅ Existing Databricks providers continue to work
- ✅ No TypeScript compilation errors
- ✅ Provider type switching shows/hides fields correctly
