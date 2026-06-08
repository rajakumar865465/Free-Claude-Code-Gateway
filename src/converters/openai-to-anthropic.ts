import type {
  AnthropicContentBlock,
  AnthropicMessagesResponse,
  AnthropicStopReason,
  AnthropicTextBlock,
  AnthropicToolUseBlock,
} from '../types/anthropic';
import type {
  OpenAIChatCompletionsResponse,
  OpenAIFinishReason,
  OpenAIToolCall,
} from '../types/openai';

export function mapFinishReason(reason: OpenAIFinishReason | undefined): AnthropicStopReason {
  if (reason === null || reason === undefined) return 'end_turn';
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'end_turn';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    default:
      return 'end_turn';
  }
}

function convertToolCall(tc: OpenAIToolCall): AnthropicToolUseBlock {
  let input: unknown = {};
  try {
    input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
  } catch {
    input = { _raw: tc.function.arguments };
  }
  return {
    type: 'tool_use',
    id: tc.id,
    name: tc.function.name,
    input,
  };
}

export function convertOpenAIResponseToAnthropic(
  openai: OpenAIChatCompletionsResponse,
  fallbackModel: string,
): AnthropicMessagesResponse {
  const choice = openai.choices?.[0];
  const content: AnthropicContentBlock[] = [];

  // Text content
  const text = choice?.message?.content;
  if (text) {
    const textBlock: AnthropicTextBlock = { type: 'text', text };
    content.push(textBlock);
  }

  // Tool calls
  const toolCalls = choice?.message?.tool_calls;
  if (toolCalls && toolCalls.length > 0) {
    for (const tc of toolCalls) {
      content.push(convertToolCall(tc));
    }
  }

  // Ensure there's always at least an empty text block so content is never []
  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  const usage = openai.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  return {
    id: openai.id,
    type: 'message',
    role: 'assistant',
    model: openai.model || fallbackModel,
    content,
    stop_reason: mapFinishReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
    },
  };
}
