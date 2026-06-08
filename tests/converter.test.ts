import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  convertAnthropicContent,
  convertAnthropicSystem,
  validateAndConvertAnthropicRequest,
} from '../src/converters/anthropic-to-openai';

describe('anthropic-to-openai: content conversion', () => {
  it('passes through plain string content', () => {
    assert.equal(convertAnthropicContent('Hello'), 'Hello');
  });

  it('extracts single text block', () => {
    const out = convertAnthropicContent([{ type: 'text', text: 'Hello' }]);
    assert.equal(out, 'Hello');
  });

  it('joins multiple text blocks with newlines', () => {
    const out = convertAnthropicContent([
      { type: 'text', text: 'Line 1' },
      { type: 'text', text: 'Line 2' },
    ]);
    assert.equal(out, 'Line 1\nLine 2');
  });

  it('replaces image blocks with placeholder', () => {
    const out = convertAnthropicContent([
      { type: 'text', text: 'look:' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'abc' },
      },
    ]);
    assert.equal(out, 'look:\n[Image input not supported by this proxy]');
  });

  it('flattens tool_result blocks', () => {
    const out = convertAnthropicContent([
      {
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: '42',
      },
    ]);
    assert.equal(out, '42');
  });
});

describe('anthropic-to-openai: system prompt conversion', () => {
  it('returns empty string when undefined', () => {
    assert.equal(convertAnthropicSystem(undefined), '');
  });

  it('returns string as-is', () => {
    assert.equal(convertAnthropicSystem('You are helpful.'), 'You are helpful.');
  });

  it('joins text blocks with newlines', () => {
    const out = convertAnthropicSystem([
      { type: 'text', text: 'You are helpful.' },
      { type: 'text', text: 'Be concise.' },
    ]);
    assert.equal(out, 'You are helpful.\nBe concise.');
  });
});

describe('anthropic-to-openai: request validation', () => {
  it('rejects non-object body', () => {
    const out = validateAndConvertAnthropicRequest('not an object' as unknown);
    assert.equal(out.ok, false);
    if (!out.ok) {
      assert.equal(out.status, 400);
      assert.equal(out.body.error.type, 'invalid_request_error');
    }
  });

  it('rejects empty messages', () => {
    const out = validateAndConvertAnthropicRequest({ messages: [] });
    assert.equal(out.ok, false);
  });

  it('accepts streaming requests', () => {
    const out = validateAndConvertAnthropicRequest({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    assert.equal(out.ok, true);
  });

  it('rejects image input with unsupported_feature', () => {
    const out = validateAndConvertAnthropicRequest({
      model: 'claude-3-5-sonnet-20241022',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'x' },
            },
          ],
        },
      ],
    });
    assert.equal(out.ok, false);
    if (!out.ok) {
      assert.equal(out.body.error.type, 'unsupported_feature');
    }
  });

  it('accepts tool calling', () => {
    const out = validateAndConvertAnthropicRequest({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: {} } }],
    });
    assert.equal(out.ok, true);
    if (out.ok) {
      assert.ok(Array.isArray(out.request.tools));
      assert.equal(out.request.tools!.length, 1);
      assert.equal(out.request.tools![0].function.name, 'read_file');
    }
  });

  it('rejects temperature out of range', () => {
    const out = validateAndConvertAnthropicRequest({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 5,
    });
    assert.equal(out.ok, false);
  });

  it('rejects top_p out of range', () => {
    const out = validateAndConvertAnthropicRequest({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'hi' }],
      top_p: 2,
    });
    assert.equal(out.ok, false);
  });

  it('converts a valid request with system prompt', () => {
    const out = validateAndConvertAnthropicRequest({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 512,
      temperature: 0.5,
      system: 'You are a helpful coding assistant.',
      messages: [{ role: 'user', content: 'Write a hello world.' }],
    });
    assert.equal(out.ok, true);
    if (out.ok) {
      assert.equal(out.request.model, 'claude-3-5-sonnet-20241022');
      assert.equal(out.request.stream, false);
      assert.equal(out.request.max_tokens, 512);
      assert.equal(out.request.temperature, 0.5);
      assert.equal(out.request.messages.length, 2);
      assert.equal(out.request.messages[0].role, 'system');
      assert.equal(out.request.messages[0].content, 'You are a helpful coding assistant.');
      assert.equal(out.request.messages[1].role, 'user');
      assert.equal(out.request.messages[1].content, 'Write a hello world.');
    }
  });

  it('defaults max_tokens when missing', () => {
    const out = validateAndConvertAnthropicRequest({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(out.ok, true);
    if (out.ok) {
      assert.equal(out.request.max_tokens, 4096);
    }
  });

  it('flattens array content to plain text', () => {
    const out = validateAndConvertAnthropicRequest({
      model: 'claude-3-5-sonnet-20241022',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'A' },
            { type: 'text', text: 'B' },
          ],
        },
      ],
    });
    assert.equal(out.ok, true);
    if (out.ok) {
      assert.equal(out.request.messages[0].content, 'A\nB');
    }
  });
});
