import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  convertOpenAIResponseToAnthropic,
  mapFinishReason,
} from '../src/converters/openai-to-anthropic';
import type { OpenAIChatCompletionsResponse } from '../src/types/openai';

describe('openai-to-anthropic: finish reason mapping', () => {
  it('maps stop -> end_turn', () => {
    assert.equal(mapFinishReason('stop'), 'end_turn');
  });
  it('maps length -> max_tokens', () => {
    assert.equal(mapFinishReason('length'), 'max_tokens');
  });
  it('maps content_filter -> end_turn', () => {
    assert.equal(mapFinishReason('content_filter'), 'end_turn');
  });
  it('maps tool_calls -> tool_use', () => {
    assert.equal(mapFinishReason('tool_calls'), 'tool_use');
  });
  it('maps function_call -> tool_use', () => {
    assert.equal(mapFinishReason('function_call'), 'tool_use');
  });
  it('maps null/undefined -> end_turn', () => {
    assert.equal(mapFinishReason(null), 'end_turn');
    assert.equal(mapFinishReason(undefined), 'end_turn');
  });
  it('maps unknown -> end_turn', () => {
    assert.equal(mapFinishReason('mystery' as never), 'end_turn');
  });
});

describe('openai-to-anthropic: response conversion', () => {
  it('converts a standard completion', () => {
    const openai: OpenAIChatCompletionsResponse = {
      id: 'chatcmpl_1',
      object: 'chat.completion',
      created: 1_700_000_000,
      model: 'gpt-4.1',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hello there.' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const out = convertOpenAIResponseToAnthropic(openai, 'fallback');
    assert.equal(out.id, 'chatcmpl_1');
    assert.equal(out.type, 'message');
    assert.equal(out.role, 'assistant');
    assert.equal(out.model, 'gpt-4.1');
    assert.equal(out.stop_reason, 'end_turn');
    assert.equal(out.stop_sequence, null);
    assert.equal(out.content.length, 1);
    assert.equal(out.content[0].type, 'text');
    if (out.content[0].type === 'text') {
      assert.equal(out.content[0].text, 'Hello there.');
    }
    assert.deepEqual(out.usage, { input_tokens: 10, output_tokens: 5 });
  });

  it('handles missing usage and content gracefully', () => {
    const openai: OpenAIChatCompletionsResponse = {
      id: 'x',
      object: 'chat.completion',
      created: 0,
      model: '',
      choices: [
        { index: 0, message: { role: 'assistant', content: '' }, finish_reason: null },
      ],
    };
    const out = convertOpenAIResponseToAnthropic(openai, 'fallback-model');
    assert.equal(out.model, 'fallback-model');
    assert.equal(out.stop_reason, 'end_turn');
    assert.equal(out.usage.input_tokens, 0);
    assert.equal(out.usage.output_tokens, 0);
    if (out.content[0].type === 'text') {
      assert.equal(out.content[0].text, '');
    }
  });
});
