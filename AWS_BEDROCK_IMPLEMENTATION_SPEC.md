# AWS Bedrock Provider Implementation Specification

## Overview
This document outlines the complete implementation plan for adding AWS Bedrock as a built-in provider.

## Phase 1: Dependencies & Setup

### 1.1 Install AWS SDK
```bash
npm install @aws-sdk/client-bedrock-runtime @aws-sdk/credential-providers
```

Packages needed:
- `@aws-sdk/client-bedrock-runtime` - Bedrock Runtime client for model invocation
- `@aws-sdk/credential-providers` - AWS credential providers (IAM roles, environment, etc.)

### 1.2 Add TypeScript Types
Create `src/types/aws-bedrock.ts`:
```typescript
export interface AWSBedrockConfig {
  region: string;
  authMethod: 'access_keys' | 'iam_role';
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  modelId: string;
}

export interface BedrockMessage {
  role: 'user' | 'assistant';
  content: Array<{
    text: string;
  }>;
}

export interface BedrockConverseRequest {
  modelId: string;
  messages: BedrockMessage[];
  system?: Array<{ text: string }>;
  inferenceConfig?: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
  };
}
```

## Phase 2: Provider Schema Updates

### 2.1 Update Provider Interface (src/admin/provider-manager.ts)

```typescript
export interface Provider {
  id: string;
  name: string;
  type?: string; // Add 'aws_bedrock'
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  notes: string;
  createdAt: string;
  
  // AWS Bedrock specific fields
  awsRegion?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string; // MUST BE ENCRYPTED
  awsSessionToken?: string; // MUST BE ENCRYPTED
  awsAuthMethod?: 'access_keys' | 'iam_role';
}
```

### 2.2 Update Valid Provider Types

In `validateInput()` method:
```typescript
const validTypes = [
  'openai-compatible', 
  'openai', 
  'anthropic', 
  'google-gemini', 
  'groq', 
  'openrouter', 
  'databricks',
  'aws_bedrock' // ADD THIS
];
```

### 2.3 Add AWS Bedrock Validation Logic

```typescript
// In validateInput() method, add after type validation:
if (out.type === 'aws_bedrock') {
  // Validate AWS Region
  if ('awsRegion' in p) {
    const v = p.awsRegion;
    if (typeof v !== 'string' || v.trim().length === 0) {
      throw new ProviderValidationError('awsRegion is required for AWS Bedrock');
    }
    out.awsRegion = v.trim();
  } else if (!partial) {
    throw new ProviderValidationError('awsRegion is required for AWS Bedrock');
  }

  // Validate Auth Method
  if ('awsAuthMethod' in p) {
    const v = p.awsAuthMethod;
    if (v !== 'access_keys' && v !== 'iam_role') {
      throw new ProviderValidationError('awsAuthMethod must be access_keys or iam_role');
    }
    out.awsAuthMethod = v;
  } else if (!partial) {
    out.awsAuthMethod = 'access_keys'; // default
  }

  // Validate credentials for access_keys method
  if (out.awsAuthMethod === 'access_keys') {
    if ('awsAccessKeyId' in p && !partial) {
      const v = p.awsAccessKeyId;
      if (typeof v !== 'string' || v.trim().length === 0) {
        throw new ProviderValidationError('awsAccessKeyId is required for access_keys auth');
      }
      out.awsAccessKeyId = v.trim();
    }
    
    if ('awsSecretAccessKey' in p && !partial) {
      const v = p.awsSecretAccessKey;
      if (typeof v !== 'string' || v.trim().length === 0) {
        throw new ProviderValidationError('awsSecretAccessKey is required for access_keys auth');
      }
      // TODO: ENCRYPT THIS BEFORE STORING
      out.awsSecretAccessKey = v.trim();
    }
    
    // Session token is optional
    if ('awsSessionToken' in p) {
      const v = p.awsSessionToken;
      if (typeof v === 'string' && v.trim().length > 0) {
        // TODO: ENCRYPT THIS BEFORE STORING
        out.awsSessionToken = v.trim();
      }
    }
  }
  
  // For aws_bedrock, baseUrl is not used
  out.baseUrl = '';
}
```

## Phase 3: Credential Encryption

### 3.1 Create Encryption Utility (src/utils/encryption.ts)

```typescript
import * as crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

// Get encryption key from environment or generate one
function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (key) {
    return Buffer.from(key, 'hex');
  }
  // Generate and warn
  const generated = crypto.randomBytes(KEY_LENGTH);
  console.warn('WARNING: No ENCRYPTION_KEY set. Generated temporary key. Secrets will not persist across restarts.');
  return generated;
}

export function encrypt(text: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  // Format: iv:authTag:encrypted
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

export function decrypt(encrypted: string): string {
  const key = getEncryptionKey();
  const parts = encrypted.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted format');
  }
  
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encryptedText = parts[2];
  
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}
```

### 3.2 Update Provider Manager to Encrypt Secrets

In `add()` and `update()` methods:
```typescript
// Before storing
if (type === 'aws_bedrock' && awsAuthMethod === 'access_keys') {
  if (awsSecretAccessKey) {
    provider.awsSecretAccessKey = encrypt(awsSecretAccessKey);
  }
  if (awsSessionToken) {
    provider.awsSessionToken = encrypt(awsSessionToken);
  }
}
```

### 3.3 Decrypt When Retrieving
```typescript
getActive(): Provider | null {
  if (!this.activeId) return null;
  const provider = this.providers.find((p) => p.id === this.activeId) ?? null;
  if (provider && provider.type === 'aws_bedrock' && provider.awsAuthMethod === 'access_keys') {
    // Decrypt secrets for use
    if (provider.awsSecretAccessKey) {
      provider.awsSecretAccessKey = decrypt(provider.awsSecretAccessKey);
    }
    if (provider.awsSessionToken) {
      provider.awsSessionToken = decrypt(provider.awsSessionToken);
    }
  }
  return provider;
}
```

## Phase 4: AWS Bedrock Adapter

### 4.1 Create Bedrock Adapter (src/adapters/bedrock-adapter.ts)

```typescript
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { fromEnv, fromContainerMetadata, fromInstanceMetadata } from '@aws-sdk/credential-providers';
import type { AWSBedrockConfig } from '../types/aws-bedrock';
import type { OpenAIChatCompletionsRequest, OpenAIChatCompletionsResponse } from '../types/openai';

export class BedrockAdapter {
  private client: BedrockRuntimeClient;
  private modelId: string;

  constructor(config: AWSBedrockConfig) {
    this.modelId = config.modelId;
    
    // Create credentials based on auth method
    const credentials = config.authMethod === 'access_keys' && config.accessKeyId && config.secretAccessKey
      ? {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
          sessionToken: config.sessionToken,
        }
      : undefined; // Use default credential chain

    this.client = new BedrockRuntimeClient({
      region: config.region,
      credentials,
    });
  }

  /**
   * Convert OpenAI-style request to Bedrock Converse API format
   */
  private convertRequest(openaiReq: OpenAIChatCompletionsRequest) {
    const messages = [];
    const systemMessages = [];

    for (const msg of openaiReq.messages) {
      if (msg.role === 'system') {
        systemMessages.push({ text: msg.content as string });
      } else if (msg.role === 'user' || msg.role === 'assistant') {
        messages.push({
          role: msg.role,
          content: [{ text: msg.content as string }],
        });
      }
    }

    const inferenceConfig: any = {};
    if (openaiReq.max_tokens) inferenceConfig.maxTokens = openaiReq.max_tokens;
    if (openaiReq.temperature !== undefined) inferenceConfig.temperature = openaiReq.temperature;
    if (openaiReq.top_p !== undefined) inferenceConfig.topP = openaiReq.top_p;

    return {
      modelId: this.modelId,
      messages,
      system: systemMessages.length > 0 ? systemMessages : undefined,
      inferenceConfig: Object.keys(inferenceConfig).length > 0 ? inferenceConfig : undefined,
    };
  }

  /**
   * Convert Bedrock response to OpenAI format
   */
  private convertResponse(bedrockResp: any): OpenAIChatCompletionsResponse {
    const content = bedrockResp.output?.message?.content?.[0]?.text || '';
    
    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: this.modelId,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content,
          },
          finish_reason: bedrockResp.stopReason === 'end_turn' ? 'stop' : 'length',
        },
      ],
      usage: {
        prompt_tokens: bedrockResp.usage?.inputTokens || 0,
        completion_tokens: bedrockResp.usage?.outputTokens || 0,
        total_tokens: (bedrockResp.usage?.inputTokens || 0) + (bedrockResp.usage?.outputTokens || 0),
      },
    };
  }

  /**
   * Send non-streaming chat completion request
   */
  async chatCompletion(request: OpenAIChatCompletionsRequest): Promise<OpenAIChatCompletionsResponse> {
    const bedrockReq = this.convertRequest(request);
    const command = new ConverseCommand(bedrockReq);
    const response = await this.client.send(command);
    return this.convertResponse(response);
  }

  /**
   * Send streaming chat completion request
   */
  async chatCompletionStream(request: OpenAIChatCompletionsRequest): Promise<AsyncIterable<any>> {
    const bedrockReq = this.convertRequest(request);
    const command = new ConverseStreamCommand(bedrockReq);
    const response = await this.client.send(command);
    
    // Return the stream
    return response.stream || [];
  }

  /**
   * Test connection
   */
  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const testReq = {
        modelId: this.modelId,
        messages: [
          {
            role: 'user' as const,
            content: [{ text: 'Hi' }],
          },
        ],
        inferenceConfig: {
          maxTokens: 10,
        },
      };
      
      const command = new ConverseCommand(testReq);
      await this.client.send(command);
      
      return { success: true };
    } catch (error: any) {
      return {
        success: false,
        error: this.formatError(error),
      };
    }
  }

  private formatError(error: any): string {
    // Format AWS-specific errors into user-friendly messages
    const code = error.name || error.code;
    const message = error.message;

    switch (code) {
      case 'ResourceNotFoundException':
        return 'Model not found or not enabled in this region';
      case 'AccessDeniedException':
        return 'Access denied. Check IAM permissions for bedrock:InvokeModel';
      case 'ValidationException':
        return `Invalid request: ${message}`;
      case 'ThrottlingException':
        return 'Request throttled. Too many requests';
      case 'ServiceQuotaExceededException':
        return 'Service quota exceeded';
      case 'ModelTimeoutException':
        return 'Model request timed out';
      case 'ModelNotReadyException':
        return 'Model is not ready';
      case 'UnauthorizedException':
        return 'Invalid AWS credentials';
      case 'ExpiredTokenException':
        return 'AWS session token expired';
      default:
        return message || 'Unknown AWS Bedrock error';
    }
  }
}
```

## Phase 5: Frontend Updates

### 5.1 Update HTML Form (public/admin/index.html)

Add AWS Bedrock option to provider type dropdown:
```html
<select id="pf-type" class="form-select">
  <option value="openai-compatible">OpenAI Compatible</option>
  <option value="openai">OpenAI</option>
  <option value="anthropic">Anthropic</option>
  <option value="google-gemini">Google Gemini</option>
  <option value="groq">Groq</option>
  <option value="openrouter">OpenRouter</option>
  <option value="databricks">Databricks</option>
  <option value="aws_bedrock">AWS Bedrock</option>
</select>
```

Add AWS Bedrock fields (after Databricks fields):
```html
<!-- AWS Bedrock Fields -->
<div id="pf-aws-bedrock-fields" style="display:none">
  <label class="form-field">
    <span class="form-label">Authentication Method <span class="form-required">*</span></span>
    <select id="pf-aws-auth-method" class="form-select">
      <option value="access_keys">AWS Access Keys</option>
      <option value="iam_role">IAM Role / Default AWS Credentials</option>
    </select>
    <span class="form-hint">Choose how to authenticate with AWS</span>
  </label>

  <div id="pf-aws-credentials-fields">
    <label class="form-field">
      <span class="form-label">AWS Region <span class="form-required">*</span></span>
      <select id="pf-aws-region" class="form-select">
        <option value="">Select a region...</option>
        <option value="us-east-1">US East (N. Virginia) - us-east-1</option>
        <option value="us-west-2">US West (Oregon) - us-west-2</option>
        <option value="eu-west-1">Europe (Ireland) - eu-west-1</option>
        <option value="eu-central-1">Europe (Frankfurt) - eu-central-1</option>
        <option value="ap-southeast-1">Asia Pacific (Singapore) - ap-southeast-1</option>
        <option value="ap-southeast-2">Asia Pacific (Sydney) - ap-southeast-2</option>
        <option value="ap-northeast-1">Asia Pacific (Tokyo) - ap-northeast-1</option>
        <option value="ap-south-1">Asia Pacific (Mumbai) - ap-south-1</option>
      </select>
      <span class="form-hint">AWS region where your Bedrock models are enabled</span>
    </label>

    <label class="form-field" id="pf-aws-access-key-field">
      <span class="form-label">AWS Access Key ID <span class="form-required">*</span></span>
      <input id="pf-aws-access-key-id" type="text" placeholder="AKIA..." autocomplete="off" />
      <span class="form-hint">Your AWS IAM access key ID</span>
    </label>

    <label class="form-field" id="pf-aws-secret-key-field">
      <span class="form-label">AWS Secret Access Key <span class="form-required">*</span></span>
      <div class="input-with-icon">
        <input id="pf-aws-secret-key" type="password" placeholder="" autocomplete="new-password" />
        <button class="input-eye-btn" type="button" id="pf-aws-secret-toggle" tabindex="-1">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" id="pf-aws-secret-eye"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
      </div>
      <span class="form-hint">Your AWS IAM secret access key (encrypted before storage)</span>
    </label>

    <label class="form-field" id="pf-aws-session-token-field">
      <span class="form-label">AWS Session Token (Optional)</span>
      <input id="pf-aws-session-token" type="password" placeholder="" autocomplete="off" />
      <span class="form-hint">Required only for temporary credentials</span>
    </label>
  </div>
</div>
```

### 5.2 Update JavaScript (public/admin/dashboard.js)

Add field visibility logic:
```javascript
// In provider type change handler
} else if (type === 'aws_bedrock') {
  // Show AWS Bedrock fields, hide others
  pfBaseUrlField.style.display = 'none';
  const awsFields = $('#pf-aws-bedrock-fields');
  if (awsFields) awsFields.style.display = '';
  
  // Handle auth method change
  const authMethod = $('#pf-aws-auth-method');
  if (authMethod) {
    const updateAwsFields = () => {
      const method = authMethod.value;
      const credFields = ['pf-aws-access-key-field', 'pf-aws-secret-key-field', 'pf-aws-session-token-field'];
      credFields.forEach(id => {
        const field = $(`#${id}`);
        if (field) {
          field.style.display = method === 'access_keys' ? '' : 'none';
        }
      });
    };
    authMethod.addEventListener('change', updateAwsFields);
    updateAwsFields();
  }
}
```

### 5.3 Add AWS Regions Helper
```javascript
const AWS_BEDROCK_REGIONS = [
  { value: 'us-east-1', label: 'US East (N. Virginia)' },
  { value: 'us-west-2', label: 'US West (Oregon)' },
  { value: 'eu-west-1', label: 'Europe (Ireland)' },
  { value: 'eu-central-1', label: 'Europe (Frankfurt)' },
  { value: 'ap-southeast-1', label: 'Asia Pacific (Singapore)' },
  { value: 'ap-southeast-2', label: 'Asia Pacific (Sydney)' },
  { value: 'ap-northeast-1', label: 'Asia Pacific (Tokyo)' },
  { value: 'ap-south-1', label: 'Asia Pacific (Mumbai)' },
];
```

## Phase 6: Backend Integration

### 6.1 Update Config Manager (src/admin/config-manager.ts)

Add methods to get AWS config:
```typescript
getAwsBedrockConfig(): AWSBedrockConfig | null {
  if (!this.providerManager) return null;
  const active = this.providerManager.getActive();
  if (!active || active.type !== 'aws_bedrock') return null;
  
  if (!active.awsRegion || !active.defaultModel) return null;
  
  return {
    region: active.awsRegion,
    authMethod: active.awsAuthMethod || 'iam_role',
    accessKeyId: active.awsAccessKeyId,
    secretAccessKey: active.awsSecretAccessKey,
    sessionToken: active.awsSessionToken,
    modelId: active.defaultModel,
  };
}
```

### 6.2 Update Routes (src/routes/chat-completions.routes.ts & messages.routes.ts)

Check for AWS Bedrock provider and route accordingly:
```typescript
// In chat completion handler
const activeProvider = state.providerManager.getActive();

if (activeProvider?.type === 'aws_bedrock') {
  // Use Bedrock adapter
  const bedrockConfig = state.configManager.getAwsBedrockConfig();
  if (!bedrockConfig) {
    return res.status(500).json({ error: { message: 'AWS Bedrock not configured' } });
  }
  
  const adapter = new BedrockAdapter(bedrockConfig);
  
  if (body.stream) {
    // Handle streaming
    const stream = await adapter.chatCompletionStream(body);
    // Convert to SSE format and pipe to response
  } else {
    // Handle non-streaming
    const result = await adapter.chatCompletion(body);
    return res.json(result);
  }
}
```

## Phase 7: Test Connection

### 7.1 Update Test Endpoint (src/admin/routes/admin-api.routes.ts)

```typescript
router.post('/providers/:id/test', async (req: Request, res: Response) => {
  const provider = state.providerManager.getById(req.params.id);
  if (!provider) {
    return res.status(404).json({ error: 'Provider not found' });
  }
  
  if (provider.type === 'aws_bedrock') {
    try {
      const bedrockConfig = {
        region: provider.awsRegion!,
        authMethod: provider.awsAuthMethod || 'iam_role',
        accessKeyId: provider.awsAccessKeyId,
        secretAccessKey: provider.awsSecretAccessKey,
        sessionToken: provider.awsSessionToken,
        modelId: provider.defaultModel,
      };
      
      const adapter = new BedrockAdapter(bedrockConfig);
      const result = await adapter.testConnection();
      
      if (result.success) {
        return res.json({ 
          success: true,
          message: `AWS Bedrock connection successful. Model ${provider.defaultModel} is accessible in ${provider.awsRegion}.`
        });
      } else {
        return res.json({
          success: false,
          error: result.error,
        });
      }
    } catch (error: any) {
      return res.json({
        success: false,
        error: error.message || 'AWS Bedrock connection failed',
      });
    }
  }
  
  // ... existing code for other providers
});
```

## Phase 8: Documentation

Create `docs/AWS_BEDROCK_SETUP.md` with:
- Prerequisites (AWS account, IAM permissions)
- How to enable Bedrock models
- IAM policy examples
- Authentication methods
- Region availability
- Model IDs reference
- Troubleshooting

## Phase 9: Security Checklist

- [ ] Secrets encrypted at rest
- [ ] Secrets never logged
- [ ] Secrets never returned in API responses
- [ ] Credentials masked in frontend
- [ ] ENCRYPTION_KEY environment variable documented
- [ ] IAM role usage preferred over static keys
- [ ] Session tokens supported for temporary credentials
- [ ] Credential validation before storage
- [ ] Proper error messages (no secret leakage)

## Phase 10: Testing Checklist

- [ ] Add AWS Bedrock provider with access keys
- [ ] Add AWS Bedrock provider with IAM role
- [ ] Test connection succeeds with valid credentials
- [ ] Test connection fails gracefully with invalid credentials
- [ ] Send chat completion request
- [ ] Send streaming request
- [ ] Edit provider and update region
- [ ] Edit provider and update model ID
- [ ] Switch between providers
- [ ] Failover between providers
- [ ] Credentials persist across restarts (with ENCRYPTION_KEY)
- [ ] Secrets not visible in API responses
- [ ] Secrets not visible in logs

## Estimated Implementation Time

- Phase 1-3: 2-3 hours (dependencies, schema, encryption)
- Phase 4: 3-4 hours (Bedrock adapter)
- Phase 5: 2-3 hours (frontend)
- Phase 6: 2-3 hours (backend integration)
- Phase 7: 1 hour (test connection)
- Phase 8: 1 hour (documentation)
- Phase 9-10: 2-3 hours (security review, testing)

**Total: 13-20 hours**

## Implementation Priority

This is a complex feature. Recommend implementing in stages:
1. **Stage 1**: Basic AWS Bedrock with access keys only
2. **Stage 2**: Add IAM role support
3. **Stage 3**: Add streaming support
4. **Stage 4**: Add comprehensive error handling

## Next Steps

1. Install npm packages
2. Review and approve this specification
3. Begin Phase 1 implementation
4. Test incrementally after each phase
