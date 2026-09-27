/**
 * Maps Anthropic/Claude messages format to the new OpenAI Responses API format, and vice-versa.
 * The Responses API uses `input` instead of `messages` and returns `output` instead of `choices`.
 */

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((item) => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') return item.text;
    return '';
  }).filter(Boolean).join('\n');
}

function convertToolChoice(toolChoice: any, hasTools: boolean): any {
  if (!hasTools) return undefined;
  if (!toolChoice) return 'auto';
  if (toolChoice.type === 'auto') return 'auto';
  if (toolChoice.type === 'any') return 'required';
  if (toolChoice.type === 'none') return 'none';
  if (toolChoice.type === 'tool' && typeof toolChoice.name === 'string') {
    return { type: 'function', name: toolChoice.name };
  }
  return 'auto';
}

// Claude clients send the conversation back on each turn, but Anthropic's
// schema has nowhere to carry opaque Responses reasoning items. Keep the
// original Azure items by call_id so the following tool-result turn can
// reconstruct the stateless Responses input correctly.
const responseItemsByCallId = new Map<string, any[]>();
const MAX_CACHED_TOOL_CALLS = 500;

function rememberResponseItems(callId: string, items: any[]): void {
  if (!callId || items.length === 0) return;
  responseItemsByCallId.delete(callId);
  responseItemsByCallId.set(callId, items);
  while (responseItemsByCallId.size > MAX_CACHED_TOOL_CALLS) {
    const oldest = responseItemsByCallId.keys().next().value as string | undefined;
    if (!oldest) break;
    responseItemsByCallId.delete(oldest);
  }
}

export function resetResponsesMapperState(): void {
  responseItemsByCallId.clear();
}

export function convertAnthropicToResponsesRequest(body: any, targetModel: string): any {
  const inputItems: any[] = [];

  let instructions: string | undefined;
  // System prompt handling
  if (body.system) {
    const systemText = typeof body.system === 'string'
      ? body.system
      : Array.isArray(body.system)
        ? body.system.map((s: any) => s.text || '').join('\n')
        : String(body.system);
    if (systemText.trim()) {
      instructions = systemText;
    }
  }

  if (body.messages && Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      const role = msg.role;
      const textType = role === 'assistant' ? 'output_text' : 'input_text';

      if (typeof msg.content === 'string') {
        inputItems.push({
          role: role,
          content: [{ type: textType, text: msg.content || ' ' }],
        });
      } else if (Array.isArray(msg.content)) {
        const messageContent: any[] = [];
        const functionCalls: any[] = [];
        const functionOutputs: any[] = [];
        // Preserved Responses items are split by kind so we can re-emit them in
        // the order Azure requires: reasoning MUST precede the assistant message
        // and the function_call it produced. Bundling them together (or emitting
        // the assistant output_text before the reasoning item) makes Azure reject
        // the tool-result turn, which silently breaks multi-turn tool use.
        const preservedReasoning: any[] = [];
        const preservedCalls: any[] = [];
        const preservedItemIds = new Set<string>();
        for (const c of msg.content) {
          if (typeof c === 'string') {
            messageContent.push({ type: textType, text: c });
          } else if (c.type === 'text') {
            messageContent.push({ type: textType, text: c.text });
          } else if (c.type === 'image' && role === 'user') {
            const imageUrl = c.source?.type === 'base64'
              ? `data:${c.source.media_type};base64,${c.source.data}`
              : c.source?.url;
            if (imageUrl) messageContent.push({ type: 'input_image', image_url: imageUrl });
          } else if (c.type === 'tool_use' && role === 'assistant') {
            const cachedItems = responseItemsByCallId.get(c.id);
            if (cachedItems) {
              for (const item of cachedItems) {
                const key = item?.id || `${item?.type || 'item'}:${item?.call_id || ''}`;
                if (preservedItemIds.has(key)) continue;
                preservedItemIds.add(key);
                if (item?.type === 'reasoning') preservedReasoning.push(item);
                else preservedCalls.push(item);
              }
            } else {
              functionCalls.push({
                type: 'function_call', call_id: c.id, name: c.name,
                arguments: typeof c.input === 'string' ? c.input : JSON.stringify(c.input ?? {}),
              });
            }
          } else if (c.type === 'tool_result' && role === 'user') {
            functionOutputs.push({
              type: 'function_call_output', call_id: c.tool_use_id,
              output: contentToText(c.content) || ' ',
            });
          }
        }
        // Order matters for the Azure Responses API:
        //   function_call_output (from a preceding assistant's calls)
        //   → reasoning → assistant message (output_text) → function_call
        inputItems.push(...functionOutputs);
        inputItems.push(...preservedReasoning);
        if (messageContent.length > 0) inputItems.push({ role, content: messageContent });
        inputItems.push(...preservedCalls);
        inputItems.push(...functionCalls);
      }
    }
  }

  const tools = Array.isArray(body.tools) ? body.tools.map((tool: any) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema ?? { type: 'object', properties: {} },
  })) : undefined;
  const toolChoice = convertToolChoice(body.tool_choice, Boolean(tools?.length));

  return {
    model: targetModel,
    input: inputItems,
    ...(instructions ? { instructions } : {}),
    ...(typeof body.max_tokens === 'number' ? { max_output_tokens: body.max_tokens } : {}),
    ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === 'number' ? { top_p: body.top_p } : {}),
    ...(tools?.length ? { tools, tool_choice: toolChoice } : {}),
    ...(body.stream !== undefined && { stream: body.stream }),
    store: false,
    include: ['reasoning.encrypted_content'],
  };
}

export function convertResponsesToAnthropic(responsesOutput: any): any {
  // Translate a Responses API output object back to Chat Completions format
  // so the rest of the proxy (which converts OpenAI to Anthropic) works correctly.
  
  // Responses API returns:
  // {
  //   "id": "res_123",
  //   "object": "response",
  //   "output": [
  //     { "type": "message", "role": "assistant", "content": "The capital is Paris." }
  //   ]
  // }
  // Or string output if primitive `response.output_text`.
  // Wait, the Python snippet used `response.output[0]`.

  let content = '';
  const toolCalls: any[] = [];
  const reasoningItems: any[] = [];
  if (responsesOutput && responsesOutput.output && Array.isArray(responsesOutput.output)) {
    for (const out of responsesOutput.output) {
      if (typeof out === 'string') {
        content += out;
      } else if (out && out.type === 'reasoning') {
        // Preserve opaque reasoning state for the next tool-result turn.
        reasoningItems.push(out);
        continue;
      } else if (out && out.type === 'function_call') {
        const callId = out.call_id || out.id || `call_${Date.now()}_${toolCalls.length}`;
        rememberResponseItems(callId, [...reasoningItems, out]);
        toolCalls.push({
          id: callId,
          type: 'function',
          function: {
            name: out.name || 'unknown_tool',
            arguments: typeof out.arguments === 'string'
              ? out.arguments
              : JSON.stringify(out.arguments ?? {}),
          },
        });
      } else if (out && (out.type === 'message' || out.role === 'assistant')) {
        if (typeof out.content === 'string') {
          content += out.content;
        } else if (Array.isArray(out.content)) {
          for (const item of out.content) {
            if (typeof item === 'string') content += item;
            else if (item && typeof item.text === 'string') content += item.text;
          }
        }
      } else if (out && typeof out.text === 'string') {
        content += out.text;
      }
    }
  }
  if (!content && responsesOutput && typeof responsesOutput.output_text === 'string') {
    content = responsesOutput.output_text;
  }


  const responseUsage = responsesOutput?.usage;
  const usage = responseUsage ? {
    prompt_tokens: responseUsage.input_tokens ?? responseUsage.prompt_tokens ?? 0,
    completion_tokens: responseUsage.output_tokens ?? responseUsage.completion_tokens ?? 0,
    total_tokens: responseUsage.total_tokens
      ?? ((responseUsage.input_tokens ?? 0) + (responseUsage.output_tokens ?? 0)),
  } : {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
  // Map to Chat Completions `choices` format
  return {
    id: responsesOutput.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: responsesOutput.created || Math.floor(Date.now() / 1000),
    model: responsesOutput.model || 'unknown',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: content || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length > 0
          ? 'tool_calls' : responsesOutput?.status === 'incomplete' ? 'length' : 'stop',
      }
    ],
    usage,
  };
}
