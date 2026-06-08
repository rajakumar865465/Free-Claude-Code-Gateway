import type {
  AnthropicErrorType,
  AnthropicErrorResponse,
} from '../types/anthropic';
import type { OpenAIErrorResponse } from '../types/openai';

const TIER_KEYWORDS = [
  'tier restriction',
  'tier',
  'plan does not have access',
  'not have access',
  'upgrade',
  'permission',
  'forbidden for',
  'restricted',
];

const INVALID_MODEL_KEYWORDS = [
  'model not found',
  'invalid model',
  'unknown model',
  'no such model',
  'model does not exist',
  'model_not_found',
];

const RATE_LIMIT_KEYWORDS = ['rate limit', 'rate_limit', 'too many requests', 'quota exceeded'];

const TIMEOUT_KEYWORDS = ['timeout', 'timed out', 'etimedout', 'econnaborted'];

const INVALID_KEY_KEYWORDS = [
  'invalid api key',
  'invalid_api_key',
  'incorrect api key',
  'unauthorized',
  'authentication',
  'api key not valid',
];

const OVERLOADED_KEYWORDS = ['overloaded', 'server is busy', 'try again', '529', 'bad_response_status_code', 'openai_error'];

export function mapOpenAIErrorToAnthropic(err: OpenAIErrorResponse): AnthropicErrorResponse {
  const status = err.status;
  const message = err.body?.error?.message ?? 'Unknown upstream error';
  const lower = message.toLowerCase();

  if (status === 401 || INVALID_KEY_KEYWORDS.some((k) => lower.includes(k))) {
    return {
      status: 401,
      body: {
        type: 'error',
        error: {
          type: 'authentication_error',
          message: 'Invalid or missing upstream API key.',
        },
      },
    };
  }

  if (status === 403 || TIER_KEYWORDS.some((k) => lower.includes(k))) {
    return {
      status: 403,
      body: {
        type: 'error',
        error: {
          type: 'permission_error',
          message: `Tier Restriction: Your upstream provider account does not have access to this model. (${message})`,
        },
      },
    };
  }

  if (status === 404 || INVALID_MODEL_KEYWORDS.some((k) => lower.includes(k))) {
    return {
      status: 404,
      body: {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'Invalid model identifier. Check /v1/models and update model mapping.',
        },
      },
    };
  }

  if (status === 429 || RATE_LIMIT_KEYWORDS.some((k) => lower.includes(k))) {
    return {
      status: 429,
      body: {
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: 'Rate limit reached. Please slow down and retry.',
        },
      },
    };
  }

  if (OVERLOADED_KEYWORDS.some((k) => lower.includes(k))) {
    return {
      status: 529,
      body: {
        type: 'error',
        error: {
          type: 'overloaded_error',
          message: 'Upstream provider is overloaded. Please retry shortly.',
        },
      },
    };
  }

  if (TIMEOUT_KEYWORDS.some((k) => lower.includes(k))) {
    return {
      status: 504,
      body: {
        type: 'error',
        error: {
          type: 'timeout_error',
          message: 'The upstream provider request timed out.',
        },
      },
    };
  }

  return {
    status: status >= 400 && status < 600 ? status : 500,
    body: {
      type: 'error',
      error: {
        type: 'api_error',
        message: message || 'Upstream provider returned an error.',
      },
    },
  };
}

export function anthropicError(
  type: AnthropicErrorType,
  message: string,
  status = 400,
): AnthropicErrorResponse {
  return {
    status,
    body: {
      type: 'error',
      error: { type, message },
    },
  };
}
