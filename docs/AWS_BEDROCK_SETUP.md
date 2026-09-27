# AWS Bedrock Setup Guide

This guide explains how to configure Amazon Bedrock as a provider in the gateway.

## Overview

Amazon Bedrock support has been simplified to use Bedrock's **OpenAI-compatible API** with bearer token authentication. This means:
- ✅ Simple API key authentication (like other providers)
- ✅ No AWS SDK dependencies
- ✅ No IAM role configuration needed
- ✅ Standard OpenAI-compatible endpoints

## Prerequisites

1. **AWS Account** with access to Amazon Bedrock
2. **Bedrock API Key** (bearer token for authentication)
3. **AWS Region** where your Bedrock models are enabled
4. **Model Access** - Ensure you've enabled the specific foundation models you want to use

## Enabling Bedrock Models

Before using Bedrock models, you must enable them in the AWS Console:

1. Go to [AWS Bedrock Console](https://console.aws.amazon.com/bedrock/)
2. Navigate to **Model Access** in the left sidebar
3. Click **Request Model Access** or **Manage Model Access**
4. Select the models you want to use (e.g., Claude, Nova, Llama)
5. Submit the request and wait for approval (usually instant for most models)

### Supported Models

Common Bedrock foundation models include:
- **Claude**: `anthropic.claude-sonnet-4-5-20250929-v1:0`, `anthropic.claude-3-5-sonnet-20241022-v2:0`
- **Amazon Nova**: `amazon.nova-pro-v1:0`, `amazon.nova-lite-v1:0`, `amazon.nova-micro-v1:0`
- **Llama**: `meta.llama3-3-70b-instruct-v1:0`, `meta.llama3-2-90b-instruct-v1:0`
- **Mistral**: `mistral.mistral-large-2407-v1:0`

Check the [AWS Bedrock Model IDs documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/model-ids.html) for the complete list.

## Getting Your Bedrock API Key

Amazon Bedrock now supports API key (bearer token) authentication for OpenAI-compatible endpoints:

1. Go to the [AWS Bedrock Console](https://console.aws.amazon.com/bedrock/)
2. Navigate to **API Keys** or **Credentials** section
3. Generate a new API key for your application
4. Copy the API key (it starts with a prefix like `sk-` or similar)
5. **Store it securely** - you won't be able to see it again

> **Note**: If you don't see an API Keys section, ensure you're in a supported region and have the necessary IAM permissions.

## Region Availability

Bedrock is available in these AWS regions:
- **US East (N. Virginia)** - `us-east-1`
- **US West (Oregon)** - `us-west-2`
- **Europe (Ireland)** - `eu-west-1`
- **Europe (Frankfurt)** - `eu-central-1`
- **Asia Pacific (Singapore)** - `ap-southeast-1`
- **Asia Pacific (Sydney)** - `ap-southeast-2`
- **Asia Pacific (Tokyo)** - `ap-northeast-1`
- **Asia Pacific (Mumbai)** - `ap-south-1`

**Important**: Not all models are available in all regions. Check model availability for your selected region in the AWS Console.

## Adding AWS Bedrock Provider

### Via Admin Dashboard

1. Open the Admin Dashboard (`http://localhost:8787/admin`)
2. Click **Add Provider**
3. Fill in the form:
   - **Display Name**: `AWS Bedrock Production` (or any name)
   - **API Provider**: Select `AWS Bedrock`
   - **AWS Region**: Select your region (e.g., `us-east-1`)
   - **API Key**: Paste your Bedrock API key
   - **Default Model ID**: Enter the full model ID (e.g., `anthropic.claude-sonnet-4-5-20250929-v1:0`)
   - **Notes** (optional): Add any notes about this provider

4. Click **Test Connection** to verify the configuration
5. Click **Save Provider**

### Model ID Format

Always use the complete Bedrock model ID including the version:
```
anthropic.claude-sonnet-4-5-20250929-v1:0
amazon.nova-pro-v1:0
meta.llama3-3-70b-instruct-v1:0
```

## Testing the Connection

The gateway tests the connection by sending a minimal chat completion request to Bedrock:

```http
POST https://bedrock-mantle.{region}.amazonaws.com/chat/completions
Authorization: Bearer {your-api-key}
Content-Type: application/json

{
  "model": "{your-model-id}",
  "messages": [{"role": "user", "content": "Hello"}],
  "max_tokens": 16
}
```

**Note**: The gateway uses AWS Bedrock's OpenAI-compatible `bedrock-mantle` endpoint, which is recommended for new applications and supports Chat Completions with API key authentication.

**Common Test Failures**:
- **401 Unauthorized**: Invalid API key
- **403 Forbidden**: Model access not enabled or insufficient permissions
- **404 Not Found**: Invalid model ID or model not available in the selected region
- **429 Rate Limit**: Too many requests
- **500 Server Error**: Bedrock service issue

## Supported Features

The AWS Bedrock provider supports:
- ✅ **Chat Completions** (`/v1/chat/completions` and `/v1/messages`)
- ✅ **Streaming** (Server-Sent Events)
- ✅ **System Messages**
- ✅ **User and Assistant Messages**
- ✅ **Temperature** control
- ✅ **Max Tokens** limit
- ✅ **Top-P** sampling
- ✅ **Token Usage** reporting (input/output tokens)
- ✅ **Tool/Function Calling** (for supported models)

## Pricing

Bedrock pricing varies by model and region. Check the [AWS Bedrock Pricing page](https://aws.amazon.com/bedrock/pricing/) for current rates.

Example pricing (US East 1, as of writing):
- Claude 3.5 Sonnet: $3/million input tokens, $15/million output tokens
- Nova Pro: $1.20/million input tokens, $4.80/million output tokens
- Nova Lite: $0.06/million input tokens, $0.24/million output tokens

## Troubleshooting

### Connection Test Fails

1. **Verify API Key**: Ensure you copied the complete API key
2. **Check Region**: Make sure the region matches where your models are enabled
3. **Model Access**: Confirm the model is enabled in the AWS Console
4. **Model ID**: Use the exact model ID including version suffix
5. **Network**: Ensure your server can reach AWS endpoints

### Models Not Working

If the test succeeds but requests fail:
1. Check that the model ID is correct and includes the version
2. Verify the model is available in your selected region
3. Check AWS Bedrock service status
4. Review request parameters (some models have specific requirements)

### Rate Limits

Bedrock has default quotas per region:
- **Tokens per minute**: Varies by model (typically 20k-200k)
- **Requests per minute**: Varies by model (typically 100-1000)

Request quota increases through the AWS Console if needed.

## Security Best Practices

1. **Rotate API Keys**: Regularly rotate your Bedrock API keys
2. **Restrict Permissions**: Only grant necessary permissions to the API key
3. **Monitor Usage**: Use AWS CloudWatch to monitor Bedrock usage
4. **Secure Storage**: The gateway encrypts API keys before storing them
5. **Network Security**: Use VPC endpoints if running in AWS
6. **Environment Variables**: Never commit API keys to version control

## Advanced Configuration

### Multiple Bedrock Providers

You can add multiple Bedrock providers for different regions or use cases:

1. **Production**: `us-east-1` with Claude Sonnet
2. **Development**: `us-west-2` with Nova Lite (cheaper)
3. **Europe**: `eu-west-1` for GDPR compliance

Switch between them using the provider switcher in the admin dashboard.

### Failover Configuration

Configure automatic failover to a backup provider if Bedrock returns rate limits or errors. See the Failover documentation for details.

## Support and Resources

- [AWS Bedrock Documentation](https://docs.aws.amazon.com/bedrock/)
- [Bedrock API Reference](https://docs.aws.amazon.com/bedrock/latest/APIReference/)
- [Model IDs List](https://docs.aws.amazon.com/bedrock/latest/userguide/model-ids.html)
- [Bedrock Pricing](https://aws.amazon.com/bedrock/pricing/)
- [AWS Support](https://aws.amazon.com/support/)

## Migration from AWS SDK Version

If you were using a previous version with AWS Access Keys:

The gateway now uses Bedrock's OpenAI-compatible API instead of the AWS SDK. Your existing Bedrock providers will need to be reconfigured with:
1. An API key (bearer token) instead of AWS Access Keys
2. The same region
3. The same model ID

Old AWS credential fields are no longer used or displayed.
