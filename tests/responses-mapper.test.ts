import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  convertAnthropicToResponsesRequest,
  convertResponsesToAnthropic,
  resetResponsesMapperState,
} from '../src/utils/responses-mapper';

describe('Azure Responses API mapper', () => {
  it('forwards Claude Code tools and request controls', () => {
    const out = convertAnthropicToResponsesRequest({
      system: 'Use tools to edit files.',
      messages: [{ role: 'user', content: 'Create index.html' }],
      max_tokens: 2048,
      temperature: 0.2,
      tools: [{
        name: 'write_file',
        description: 'Write a file',
        input_schema: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
        },
      }],
      tool_choice: { type: 'tool', name: 'write_file' },
      stream: true,
    }, 'gpt-5');

    assert.equal(out.instructions, 'Use tools to edit files.');
    assert.equal(out.max_output_tokens, 2048);
    assert.equal(out.stream, true);
    assert.equal(out.tools[0].name, 'write_file');
    assert.equal(out.tools[0].parameters.required[0], 'path');
    assert.deepEqual(out.tool_choice, { type: 'function', name: 'write_file' });
  });

  it('preserves tool calls and tool outputs in conversation history', () => {
    const out = convertAnthropicToResponsesRequest({
      messages: [
        { role: 'assistant', content: [{
          type: 'tool_use', id: 'toolu_123', name: 'write_file',
          input: { path: 'index.html', content: '<h1>Hello</h1>' },
        }] },
        { role: 'user', content: [{
          type: 'tool_result', tool_use_id: 'toolu_123', content: 'File written',
        }] },
      ],
    }, 'gpt-5');

    assert.deepEqual(out.input[0], {
      type: 'function_call',
      call_id: 'toolu_123',
      name: 'write_file',
      arguments: '{"path":"index.html","content":"<h1>Hello</h1>"}',
    });
    assert.deepEqual(out.input[1], {
      type: 'function_call_output',
      call_id: 'toolu_123',
      output: 'File written',
    });
  });

  it('maps Azure function calls and token usage back to Chat Completions', () => {
    const out = convertResponsesToAnthropic({
      id: 'resp_123',
      model: 'gpt-5',
      status: 'completed',
      output: [{
        type: 'function_call', call_id: 'call_123', name: 'write_file',
        arguments: '{"path":"index.html"}',
      }],
      usage: { input_tokens: 25, output_tokens: 8, total_tokens: 33 },
    });

    assert.equal(out.choices[0].finish_reason, 'tool_calls');
    assert.equal(out.choices[0].message.content, null);
    assert.deepEqual(out.choices[0].message.tool_calls[0], {
      id: 'call_123',
      type: 'function',
      function: { name: 'write_file', arguments: '{"path":"index.html"}' },
    });
    assert.deepEqual(out.usage, {
      prompt_tokens: 25,
      completion_tokens: 8,
      total_tokens: 33,
    });
  });

  it('restores encrypted reasoning and original function-call items on the tool-result turn', () => {
    resetResponsesMapperState();
    convertResponsesToAnthropic({
      id: 'resp_reasoning',
      model: 'gpt-5',
      output: [
        { type: 'reasoning', id: 'rs_123', summary: [], encrypted_content: 'opaque-state' },
        {
          type: 'function_call', id: 'fc_123', call_id: 'call_123',
          name: 'write_file', arguments: '{"path":"index.html"}', status: 'completed',
        },
      ],
    });

    const next = convertAnthropicToResponsesRequest({
      messages: [
        { role: 'assistant', content: [{
          type: 'tool_use', id: 'call_123', name: 'write_file', input: { path: 'index.html' },
        }] },
        { role: 'user', content: [{
          type: 'tool_result', tool_use_id: 'call_123', content: 'File written',
        }] },
      ],
    }, 'gpt-5');

    assert.equal(next.store, false);
    assert.deepEqual(next.include, ['reasoning.encrypted_content']);
    assert.equal(next.input[0].type, 'reasoning');
    assert.equal(next.input[0].encrypted_content, 'opaque-state');
    assert.equal(next.input[1].id, 'fc_123');
    assert.equal(next.input[1].type, 'function_call');
    assert.equal(next.input[2].type, 'function_call_output');
    assert.equal(next.input[2].call_id, 'call_123');
  });

  it('keeps reasoning before assistant text and the function_call it produced', () => {
    // Regression: Claude replays an assistant turn that has BOTH narration text
    // and a tool call. Azure (store:false + encrypted reasoning) requires the
    // reasoning item to lead; emitting output_text first silently broke the
    // tool-result turn and collapsed the follow-up to a near-empty reply.
    resetResponsesMapperState();
    convertResponsesToAnthropic({
      id: 'resp_mixed',
      model: 'gpt-5',
      output: [
        { type: 'reasoning', id: 'rs_9', summary: [], encrypted_content: 'opaque-9' },
        {
          type: 'function_call', id: 'fc_9', call_id: 'call_9',
          name: 'write_file', arguments: '{"path":"a.txt"}', status: 'completed',
        },
      ],
    });

    const next = convertAnthropicToResponsesRequest({
      messages: [
        { role: 'assistant', content: [
          { type: 'text', text: 'Writing the file now.' },
          { type: 'tool_use', id: 'call_9', name: 'write_file', input: { path: 'a.txt' } },
        ] },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'call_9', content: 'done' },
        ] },
      ],
    }, 'gpt-5');

    // reasoning → assistant message → function_call → function_call_output
    assert.equal(next.input[0].type, 'reasoning');
    assert.equal(next.input[0].encrypted_content, 'opaque-9');
    assert.equal(next.input[1].role, 'assistant');
    assert.equal(next.input[1].content[0].type, 'output_text');
    assert.equal(next.input[1].content[0].text, 'Writing the file now.');
    assert.equal(next.input[2].type, 'function_call');
    assert.equal(next.input[2].id, 'fc_9');
    assert.equal(next.input[3].type, 'function_call_output');
    assert.equal(next.input[3].call_id, 'call_9');
  });
});
