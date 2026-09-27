/**
 * Construct the AWS Bedrock OpenAI-compatible base URL from region.
 *
 * Bedrock exposes the Chat Completions API on two endpoints:
 *   - bedrock-mantle.{region}.api.aws/v1        (recommended; API-key bearer auth)
 *   - bedrock-runtime.{region}.amazonaws.com/v1 (SigV4 or API key)
 *
 * We use bedrock-mantle because the gateway stores a Bedrock API key (bearer
 * token), not AWS SigV4 credentials. Hitting bedrock-runtime's /v1 path with a
 * bearer token returns HTTP 200 with an empty
 * `com.amazon.coral.service#UnknownOperationException` envelope — which is the
 * "bedrock model not working" symptom. bedrock-mantle.{region}.api.aws/v1
 * serves a real OpenAI-style response with the same bearer token.
 *
 * Reference: https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions-mantle.html
 *
 * @param region - AWS region (e.g., 'us-east-1', 'us-west-2')
 * @returns Base URL for the Bedrock OpenAI-compatible API (no trailing slash)
 */
export function getBedrockBaseUrl(region: string): string {
  if (!region || region.trim().length === 0) {
    throw new Error('AWS region is required to construct Bedrock base URL');
  }
  return `https://bedrock-mantle.${region}.api.aws/v1`;
}
