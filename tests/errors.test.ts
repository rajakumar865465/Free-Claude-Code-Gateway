import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapOpenAIErrorToAnthropic, anthropicError } from '../src/converters/errors';
import type { OpenAIErrorResponse } from '../src/types/openai';

function err(status: number, message: string, type?: string): OpenAIErrorResponse {
  return {
    status,
    body: {
      error: { message, type, code: null, param: null },
    },
  };
}

describe('error mapping: OpenAI -> Anthropic', () => {
  it('401 -> authentication_error', () => {
    const r = mapOpenAIErrorToAnthropic(err(401, 'Invalid API key'));
    assert.equal(r.status, 401);
    assert.equal(r.body.error.type, 'authentication_error');
  });

  it('403 with tier keyword -> permission_error', () => {
    const r = mapOpenAIErrorToAnthropic(err(403, 'Tier Restriction: not available on free plan'));
    assert.equal(r.status, 403);
    assert.equal(r.body.error.type, 'permission_error');
  });

  it('403 without tier keyword still maps to permission_error by status', () => {
    const r = mapOpenAIErrorToAnthropic(err(403, 'Forbidden'));
    assert.equal(r.body.error.type, 'permission_error');
  });

  it('404 with model-not-found keyword -> invalid_request_error', () => {
    const r = mapOpenAIErrorToAnthropic(err(404, 'The model `foo` does not exist.'));
    assert.equal(r.body.error.type, 'invalid_request_error');
  });

  it('429 -> rate_limit_error', () => {
    const r = mapOpenAIErrorToAnthropic(err(429, 'Rate limit exceeded.'));
    assert.equal(r.body.error.type, 'rate_limit_error');
  });

  it('overloaded keyword -> overloaded_error', () => {
    const r = mapOpenAIErrorToAnthropic(err(503, 'Server overloaded, try again.'));
    assert.equal(r.body.error.type, 'overloaded_error');
  });

  it('timeout keyword -> timeout_error', () => {
    const r = mapOpenAIErrorToAnthropic(err(504, 'Upstream timeout'));
    assert.equal(r.body.error.type, 'timeout_error');
  });

  it('500 generic -> api_error', () => {
    const r = mapOpenAIErrorToAnthropic(err(500, 'Something blew up.'));
    assert.equal(r.body.error.type, 'api_error');
  });

  it('anthropicError() builds a structured body', () => {
    const r = anthropicError('invalid_request_error', 'bad input', 400);
    assert.equal(r.status, 400);
    assert.equal(r.body.error.type, 'invalid_request_error');
    assert.equal(r.body.error.message, 'bad input');
  });
});
