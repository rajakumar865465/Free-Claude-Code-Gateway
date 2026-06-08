export type AnthropicRole = 'user' | 'assistant';

export type AnthropicStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | string;

export type AnthropicErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'request_too_large'
  | 'rate_limit_error'
  | 'api_error'
  | 'timeout_error'
  | 'proxy_error'
  | 'unsupported_feature'
  | 'overloaded_error';

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

export interface AnthropicImageBlock {
  type: 'image';
  source:
    | { type: 'base64'; media_type: string; data: string }
    | { type: 'url'; url: string };
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | AnthropicContentBlock[];
  is_error?: boolean;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export type AnthropicContent = string | AnthropicContentBlock[];

export interface AnthropicMessage {
  role: AnthropicRole;
  content: AnthropicContent;
}

export type AnthropicSystemPrompt = string | AnthropicTextBlock[];

export interface AnthropicToolDef {
  name: string;
  description?: string;
  input_schema?: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

export type AnthropicToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'none' }
  | { type: 'tool'; name: string };

export interface AnthropicMessagesRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens?: number;
  system?: AnthropicSystemPrompt;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  metadata?: Record<string, unknown>;
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface AnthropicMessagesResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: AnthropicStopReason | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

export interface AnthropicErrorBody {
  type: 'error';
  error: {
    type: AnthropicErrorType;
    message: string;
  };
}

export interface AnthropicErrorResponse {
  status: number;
  body: AnthropicErrorBody;
}

// Streaming event types (SSE)
export interface AnthropicStreamMessageStart {
  type: 'message_start';
  message: {
    id: string;
    type: 'message';
    role: 'assistant';
    model: string;
    content: [];
    stop_reason: null;
    stop_sequence: null;
    usage: { input_tokens: number; output_tokens: number };
  };
}

export interface AnthropicStreamContentBlockStart {
  type: 'content_block_start';
  index: number;
  content_block: { type: 'text'; text: '' };
}

export interface AnthropicStreamContentBlockDelta {
  type: 'content_block_delta';
  index: number;
  delta: { type: 'text_delta'; text: string };
}

export interface AnthropicStreamContentBlockStop {
  type: 'content_block_stop';
  index: number;
}

export interface AnthropicStreamMessageDelta {
  type: 'message_delta';
  delta: { stop_reason: AnthropicStopReason; stop_sequence: string | null };
  usage: { output_tokens: number };
}

export interface AnthropicStreamMessageStop {
  type: 'message_stop';
}

export interface AnthropicStreamPing {
  type: 'ping';
}

export interface AnthropicStreamError {
  type: 'error';
  error: { type: AnthropicErrorType; message: string };
}

export type AnthropicStreamEvent =
  | AnthropicStreamMessageStart
  | AnthropicStreamContentBlockStart
  | AnthropicStreamContentBlockDelta
  | AnthropicStreamContentBlockStop
  | AnthropicStreamMessageDelta
  | AnthropicStreamMessageStop
  | AnthropicStreamPing
  | AnthropicStreamError;
