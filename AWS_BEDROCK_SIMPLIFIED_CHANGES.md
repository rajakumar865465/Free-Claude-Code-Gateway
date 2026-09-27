# AWS Bedrock Simplification - Complete Changes Summary

## Overview
Simplifying AWS Bedrock from AWS SDK with access keys to OpenAI-compatible API with bearer token.

## Changes Made

### ✅ Frontend (HTML + JavaScript)
1. **HTML** (`public/admin/index.html`):
   - ✅ Removed AWS Access Key ID field
   - ✅ Removed AWS Secret Access Key field  
   - ✅ Removed AWS Session Token field
   - ✅ Kept only AWS Region dropdown

2. **JavaScript** (`public/admin/dashboard.js`):
   - ✅ Removed AWS secret toggle button handler
   - ✅ Updated `openProviderModal()` to only handle AWS Region
   - ✅ Updated Test Connection to validate only region, apiKey, and model
   - ✅ Updated Save Provider to only collect region (not access keys)

### ⏳ Backend Changes Needed

#### 1. Provider Schema Updates (`src/admin/provider-manager.ts`)
- ❌ Remove `awsAccessKeyId` field
- ❌ Remove `awsSecretAccessKey` field
- ❌ Remove `awsSessionToken` field
- ❌ Remove `awsAuthMethod` field
- ✅ Keep `awsRegion` field
- ❌ Remove `decryptAwsSecrets()` method
- ❌ Remove AWS-specific encryption logic from `add()` and `update()`
- ❌ Update validation to remove AWS credential checks

#### 2. Bedrock Base URL Construction
- ✅ Created utility function to build Bedrock OpenAI-compatible endpoint from region
- ✅ Format: `https://bedrock-mantle.{region}.amazonaws.com`
- ✅ Using AWS's OpenAI-compatible bedrock-mantle endpoint

#### 3. Remove BedrockAdapter
- ❌ Remove `src/adapters/bedrock-adapter.ts` (no longer needed)
- ❌ Remove AWS SDK dependency from `package.json`
- ❌ Update imports in `src/routes/chat-completions.routes.ts`
- ❌ Update imports in `src/routes/messages.routes.ts`
- ❌ Update imports in `src/admin/routes/admin-api.routes.ts`

#### 4. Route Through Standard OpenAI Logic
- ❌ In `chat-completions.routes.ts`: Remove AWS Bedrock special routing
- ❌ In `messages.routes.ts`: Remove AWS Bedrock special routing
- ❌ Let AWS Bedrock flow through standard OpenAI-compatible path
- ❌ Construct baseUrl from region before calling service

#### 5. Test Connection Updates (`src/admin/routes/admin-api.routes.ts`)
- ❌ Remove BedrockAdapter test logic
- ❌ Use standard OpenAI test with constructed baseUrl

#### 6. Remove Encryption Utility (if only used for AWS)
- ⚠️ Check if `src/utils/encryption.ts` is used elsewhere
- ❌ If only for AWS Bedrock, remove it
- ❌ If used for other secrets, keep it

## Implementation Strategy

### Option A: Full Removal (Recommended)
1. Remove all AWS-specific code
2. Treat AWS Bedrock like any other OpenAI-compatible provider
3. Just construct baseUrl from region + use standard apiKey

### Option B: Keep Minimal AWS Logic
1. Keep `awsRegion` field in schema
2. Auto-construct `baseUrl` from region in backend
3. Use standard `apiKey` field (already encrypted)
4. No special adapters or routing

## Next Steps
1. Implement Option B (simpler, less breaking)
2. Update provider-manager.ts to remove AWS credential fields
3. Add baseUrl construction helper
4. Remove BedrockAdapter and AWS SDK
5. Update routing to use standard flow
6. Test with real AWS Bedrock API key

## Notes
- AWS Bedrock now supports OpenAI-compatible API endpoints
- Uses standard bearer token authentication
- No need for AWS SDK or IAM credentials
- Simpler for users to configure
