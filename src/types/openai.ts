export type OpenAIRole = 'system' | 'user' | 'assistant' | 'tool' | 'developer';

export type OpenAIFinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'function_call'
  | null
  | string;

export interface OpenAITextContentPart {
  type: 'text';
  text: string;
}

export interface OpenAIImageUrlPart {
  type: 'image_url';
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' };
}

export type OpenAIContentPart = OpenAITextContentPart | OpenAIImageUrlPart;

export type OpenAIMessageContent = string | OpenAIContentPart[];

export interface OpenAIMessage {
  role: OpenAIRole;
  content?: OpenAIMessageContent | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

export interface OpenAIToolCallFunction {
  name: string;
  arguments: string;
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: OpenAIToolCallFunction;
}

export interface OpenAIToolFunctionDef {
  name: string;
  description?: string;
  parameters?: unknown;
}

export interface OpenAITool {
  type: 'function';
  function: OpenAIToolFunctionDef;
}

export interface OpenAIChatCompletionsRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  tools?: OpenAITool[];
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  user?: string;
  [key: string]: unknown;
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface OpenAIChatCompletionsResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason: OpenAIFinishReason;
  }>;
  usage?: OpenAIUsage;
}

export interface OpenAIErrorBody {
  error: {
    message: string;
    type?: string;
    param?: string | null;
    code?: string | string[] | null;
  };
}

export interface OpenAIErrorResponse {
  status: number;
  body: OpenAIErrorBody;
}

export interface OpenAIModelsResponse {
  object: string;
  data: Array<{
    id: string;
    object?: string;
    created?: number;
    owned_by?: string;
    [key: string]: unknown;
  }>;
}

// Streaming types
export interface OpenAIStreamDelta {
  role?: 'assistant';
  content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: 'function';
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
}

export interface OpenAIStreamChoice {
  index: number;
  delta: OpenAIStreamDelta;
  finish_reason: OpenAIFinishReason | null;
}

export interface OpenAIStreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: OpenAIStreamChoice[];  // May be empty [] on usage-only chunks
  usage?: OpenAIUsage | null;
}
