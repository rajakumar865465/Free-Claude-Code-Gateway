import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Response as ExpressResponse } from 'express';
import { BluesmindsService } from '../src/services/bluesminds.service';
import { collectResponsesCompletion, handleResponsesStreaming } from '../src/routes/messages.routes';

function azureStream(events: unknown[]): globalThis.Response {
  const payload = events.map((event) => `event: ${(event as any).type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  const bytes = new TextEncoder().encode(payload);
  const split = Math.floor(bytes.length / 2);
  return new globalThis.Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, split));
      controller.enqueue(bytes.slice(split));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

class FakeExpressResponse {
  writableEnded = false;
  statusCode = 200;
  headers = new Map<string, string>();
  chunks: string[] = [];
  jsonBody: unknown;

  setHeader(name: string, value: string): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }
  flushHeaders(): void {}
  write(chunk: string): boolean {
    this.chunks.push(String(chunk));
    return true;
  }
  end(): this {
    this.writableEnded = true;
    return this;
  }
  status(code: number): this {
    this.statusCode = code;
    return this;
  }
  json(body: unknown): this {
    this.jsonBody = body;
    this.writableEnded = true;
    return this;
  }
}

describe('Azure Responses streaming', () => {
  it('posts stream:true to /responses and returns the body without a whole-request timeout', async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = '';
    let requestedBody: any;
    globalThis.fetch = async (input, init) => {
      requestedUrl = String(input);
      requestedBody = JSON.parse(String(init?.body));
      return azureStream([]);
    };
    try {
      const service = new BluesmindsService({
        baseUrl: 'https://example.openai.azure.com/openai/v1',
        apiKey: 'test-key',
      });
      const result = await service.createResponsesCompletionStream({
        model: 'gpt-5.2-codex', input: [], stream: false,
      });
      assert.equal(result.ok, true);
      assert.equal(requestedUrl, 'https://example.openai.azure.com/openai/v1/responses');
      assert.equal(requestedBody.stream, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('translates Azure text and function-call deltas into Claude SSE events', async () => {
    const finalResponse = {
      id: 'resp_1', model: 'gpt-5.2-codex', status: 'completed',
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }] },
        { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'write_file', arguments: '{"path":"index.html"}' },
      ],
      usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
    };
    const events = [
      { type: 'response.output_text.delta', output_index: 0, delta: 'Hello' },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call_1', name: 'write_file' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path":"index.html"}' },
      { type: 'response.output_item.done', output_index: 1, item: finalResponse.output[1] },
      { type: 'response.completed', response: finalResponse },
    ];
    const service = {
      createResponsesCompletionStream: async () => ({
        ok: true as const,
        status: 200,
        response: azureStream(events),
      }),
    } as unknown as BluesmindsService;
    const response = new FakeExpressResponse();

    await handleResponsesStreaming(
      response as unknown as ExpressResponse,
      service,
      { model: 'gpt-5.2-codex', input: [] },
      'gpt-5.2-codex',
    );

    const output = response.chunks.join('');
    assert.equal(response.writableEnded, true);
    assert.match(output, /event: message_start/);
    assert.match(output, /"type":"text_delta","text":"Hello"/);
    assert.match(output, /"type":"tool_use","id":"call_1","name":"write_file"/);
    assert.match(output, /"type":"input_json_delta","partial_json":"\{\\"path\\":\\"index\.html\\"\}"/);
    assert.match(output, /"stop_reason":"tool_use"/);
    assert.match(output, /"output_tokens":7/);
    assert.match(output, /event: message_stop/);
  });
  it('aggregates a streamed terminal response for non-streaming Claude clients', async () => {
    const finalResponse = {
      id: 'resp_json', model: 'gpt-5.6-sol', status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }],
      usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 },
    };
    let streamCalls = 0;
    const service = {
      createResponsesCompletionStream: async () => {
        streamCalls++;
        return {
          ok: true as const,
          status: 200,
          response: azureStream([{ type: 'response.completed', response: finalResponse }]),
        };
      },
    } as unknown as BluesmindsService;

    const result = await collectResponsesCompletion(
      service,
      { model: 'gpt-5.6-sol', input: [] },
    );

    assert.equal(streamCalls, 1);
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.body, finalResponse);
  });
});