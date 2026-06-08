import type {
  AnthropicContent,
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicSystemPrompt,
  AnthropicToolDef,
  AnthropicToolChoice,
} from '../types/anthropic';
import type {
  OpenAIChatCompletionsRequest,
  OpenAIMessage,
  OpenAIMessageContent,
  OpenAITool,
} from '../types/openai';
import { anthropicError } from './errors';

const DEFAULT_MAX_TOKENS = 4096;

export interface ConvertResult {
  ok: true;
  request: OpenAIChatCompletionsRequest;
}

export interface ConvertFailure {
  ok: false;
  status: number;
  body: AnthropicMessagesResponseLike;
}

export type AnthropicMessagesResponseLike = ReturnType<typeof anthropicError>['body'];

// ---------------------------------------------------------------------------
// Content helpers
// ---------------------------------------------------------------------------

function joinTextBlocks(blocks: AnthropicContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push(block.text);
    } else if (block.type === 'image') {
      parts.push('[Image input not supported by this proxy]');
    } else if (block.type === 'tool_use') {
      // tool_use in user/assistant message — skip; handled separately
    } else if (block.type === 'tool_result') {
      const inner = Array.isArray(block.content)
        ? joinTextBlocks(block.content as AnthropicContentBlock[])
        : (block.content as string);
      parts.push(inner);
    }
  }
  return parts.join('\n').trim();
}

export function convertAnthropicContent(content: AnthropicContent): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return joinTextBlocks(content);
}

export function convertAnthropicSystem(system: AnthropicSystemPrompt | undefined): string {
  if (system === undefined || system === null) return '';
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system
    .map((b) => (b && b.type === 'text' ? b.text : ''))
    .filter((s) => s.length > 0)
    .join('\n')
    .trim();
}

export function hasUnsupportedFeatures(
  content: AnthropicContent,
): { unsupported: true; reason: string } | { unsupported: false } {
  if (typeof content === 'string') return { unsupported: false };
  if (!Array.isArray(content)) return { unsupported: false };
  for (const block of content) {
    if (block && block.type === 'image') {
      return { unsupported: true, reason: 'Image input is not supported in this proxy version.' };
    }
  }
  return { unsupported: false };
}

// ---------------------------------------------------------------------------
// Tool conversion: Anthropic → OpenAI
// ---------------------------------------------------------------------------

export function convertAnthropicTools(tools: AnthropicToolDef[]): OpenAITool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema ?? { type: 'object', properties: {} },
    },
  }));
}

export function convertAnthropicToolChoice(
  toolChoice: AnthropicToolChoice | undefined,
  hasTools: boolean,
): OpenAIChatCompletionsRequest['tool_choice'] {
  if (!hasTools) return undefined;
  if (!toolChoice) return 'auto';
  if (typeof toolChoice === 'object' && toolChoice !== null) {
    const tc = toolChoice as { type: string; name?: string };
    if (tc.type === 'auto') return 'auto';
    if (tc.type === 'any') return 'required';
    if (tc.type === 'none') return 'none';
    if (tc.type === 'tool' && tc.name) {
      return { type: 'function', function: { name: tc.name } };
    }
  }
  return 'auto';
}

// ---------------------------------------------------------------------------
// Message normalisation: Anthropic → OpenAI
// ---------------------------------------------------------------------------

/**
 * Convert a single Anthropic message to one or more OpenAI messages.
 *
 * Anthropic packs tool_use blocks (assistant calls) and tool_result blocks
 * (user responses) inside the message content array. OpenAI uses separate
 * messages with role "tool" for results and embeds tool_calls on the assistant
 * message.
 */
function normalizeMessages(
  msgs: AnthropicMessage[],
): { ok: true; messages: OpenAIMessage[] } | { ok: false; status: number; message: string } {
  const out: OpenAIMessage[] = [];

  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];
    if (!msg || typeof msg !== 'object') {
      return { ok: false, status: 400, message: `messages[${i}] must be an object.` };
    }
    const role = msg.role;
    if (role !== 'user' && role !== 'assistant') {
      return { ok: false, status: 400, message: `Unsupported role "${String(role)}".` };
    }
    if (msg.content === undefined || msg.content === null) {
      return { ok: false, status: 400, message: 'message.content is required.' };
    }

    if (typeof msg.content === 'string') {
      out.push({ role, content: msg.content });
      continue;
    }

    if (!Array.isArray(msg.content)) {
      out.push({ role, content: '' });
      continue;
    }

    const blocks = msg.content as AnthropicContentBlock[];

    if (role === 'assistant') {
      // Collect text and tool_use blocks
      const textParts: string[] = [];
      const toolCalls: NonNullable<OpenAIMessage['tool_calls']> = [];

      for (const block of blocks) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: typeof block.input === 'string'
                ? block.input
                : JSON.stringify(block.input ?? {}),
            },
          });
        }
      }

      const assistantMsg: OpenAIMessage = { role: 'assistant', content: textParts.join('\n') || null };
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      out.push(assistantMsg);

    } else {
      // role === 'user'
      // Check for tool_result blocks — each becomes a separate "tool" message.
      // OpenAI requires tool messages to immediately follow the assistant message
      // that produced the tool_calls, so we emit tool results BEFORE any new
      // user text to preserve the correct conversation ordering.
      const toolResults = blocks.filter((b) => b.type === 'tool_result');
      const otherBlocks = blocks.filter((b) => b.type !== 'tool_result');

      // Tool result messages first (they follow the preceding assistant message)
      for (const block of toolResults) {
        if (block.type !== 'tool_result') continue;
        const resultText = Array.isArray(block.content)
          ? joinTextBlocks(block.content as AnthropicContentBlock[])
          : (block.content as string) ?? '';

        out.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: resultText,
        });
      }

      // Regular user content after tool results
      if (otherBlocks.length > 0) {
        const text = joinTextBlocks(otherBlocks);
        if (text) out.push({ role: 'user', content: text });
      }

      // If the message had neither tool results nor other content, emit an empty user turn
      if (toolResults.length === 0 && otherBlocks.length === 0) {
        out.push({ role: 'user', content: '' });
      }
    }
  }

  return { ok: true, messages: out };
}

// ---------------------------------------------------------------------------
// Main validation + conversion
// ---------------------------------------------------------------------------

export function validateAndConvertAnthropicRequest(
  body: unknown,
): ConvertResult | ConvertFailure {
  if (!body || typeof body !== 'object') {
    return { ok: false, status: 400, body: anthropicError('invalid_request_error', 'Request body must be a JSON object.').body };
  }

  const req = body as Partial<AnthropicMessagesRequest>;

  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    return {
      ok: false,
      status: 400,
      body: anthropicError('invalid_request_error', 'messages must be a non-empty array.').body,
    };
  }

  for (let i = 0; i < req.messages.length; i += 1) {
    const m = req.messages[i] as AnthropicMessage;
    if (!m || typeof m !== 'object') {
      return { ok: false, status: 400, body: anthropicError('invalid_request_error', `messages[${i}] must be an object.`).body };
    }
    if (!m.role || m.content === undefined || m.content === null) {
      return { ok: false, status: 400, body: anthropicError('invalid_request_error', `messages[${i}] must include role and content.`).body };
    }
    const check = hasUnsupportedFeatures(m.content);
    if (check.unsupported) {
      return { ok: false, status: 400, body: anthropicError('unsupported_feature', check.reason).body };
    }
  }

  if (req.temperature !== undefined) {
    const t = Number(req.temperature);
    if (!Number.isFinite(t) || t < 0 || t > 2) {
      return { ok: false, status: 400, body: anthropicError('invalid_request_error', 'temperature must be a number between 0 and 2.').body };
    }
  }

  if (req.top_p !== undefined) {
    const tp = Number(req.top_p);
    if (!Number.isFinite(tp) || tp < 0 || tp > 1) {
      return { ok: false, status: 400, body: anthropicError('invalid_request_error', 'top_p must be a number between 0 and 1.').body };
    }
  }

  // Convert tools
  const rawTools = req.tools as AnthropicToolDef[] | undefined;
  const openaiTools = rawTools && rawTools.length > 0 ? convertAnthropicTools(rawTools) : undefined;
  const toolChoice = convertAnthropicToolChoice(
    req.tool_choice as AnthropicToolChoice | undefined,
    !!openaiTools,
  );

  // Build system message
  const openaiMessages: OpenAIMessage[] = [];
  const systemText = convertAnthropicSystem(req.system);
  if (systemText) {
    openaiMessages.push({ role: 'system', content: systemText });
  }

  // Normalise conversation messages
  const norm = normalizeMessages(req.messages as AnthropicMessage[]);
  if (!norm.ok) {
    return { ok: false, status: norm.status, body: anthropicError('invalid_request_error', norm.message).body };
  }
  openaiMessages.push(...norm.messages);

  const openaiRequest: OpenAIChatCompletionsRequest = {
    model: typeof req.model === 'string' ? req.model : '',
    messages: openaiMessages,
    max_tokens: typeof req.max_tokens === 'number' ? req.max_tokens : DEFAULT_MAX_TOKENS,
    temperature: typeof req.temperature === 'number' ? req.temperature : undefined,
    top_p: typeof req.top_p === 'number' ? req.top_p : undefined,
    stop: Array.isArray(req.stop_sequences) ? req.stop_sequences : undefined,
    stream: false,
    ...(openaiTools ? { tools: openaiTools, tool_choice: toolChoice } : {}),
  };

  return { ok: true, request: openaiRequest };
}
