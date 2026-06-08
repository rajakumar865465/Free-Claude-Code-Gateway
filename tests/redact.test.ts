import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { redactApiKey, redactHeaderValue, safeStringify } from '../src/utils/redact';

describe('redaction', () => {
  it('redacts short keys fully', () => {
    assert.equal(redactApiKey('abcd'), '****');
  });

  it('redacts long keys to prefix/suffix', () => {
    assert.equal(redactApiKey('sk-1234567890abcdef'), 'sk-1...cdef');
  });

  it('returns empty string for missing key', () => {
    assert.equal(redactApiKey(undefined), '');
    assert.equal(redactApiKey(null), '');
  });

  it('redacts Authorization header values', () => {
    assert.equal(
      redactHeaderValue('authorization', 'Bearer sk-1234567890abcdef'),
      'Bearer sk-1...cdef',
    );
  });

  it('passes through non-sensitive headers', () => {
    assert.equal(redactHeaderValue('content-type', 'application/json'), 'application/json');
  });

  it('safeStringify redacts sensitive keys', () => {
    const s = safeStringify({ apiKey: 'sk-abcdefghij123456', other: 'ok' });
    assert.ok(s.includes('[REDACTED]') || !s.includes('sk-abcdefghij123456'));
    assert.ok(s.includes('ok'));
  });
});
