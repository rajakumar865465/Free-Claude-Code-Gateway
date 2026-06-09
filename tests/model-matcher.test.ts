import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeModelId,
  scoreMatch,
  computePrefixStyle,
  buildSuggestions,
} from '../src/admin/model-matcher';

describe('normalizeModelId', () => {
  it('splits vendor prefix correctly', () => {
    const r = normalizeModelId('moonshotai/kimi-k2.6');
    assert.equal(r.vendor, 'moonshotai');
    assert.equal(r.normalized, 'kimi-k2-6');
  });

  it('handles bare model ID with no vendor', () => {
    const r = normalizeModelId('kimi-k2.6');
    assert.equal(r.vendor, null);
    assert.equal(r.normalized, 'kimi-k2-6');
  });

  it('strips -latest suffix', () => {
    const r = normalizeModelId('gpt-4o-latest');
    assert.equal(r.normalized, 'gpt-4o');
  });

  it('strips -preview suffix', () => {
    const r = normalizeModelId('gemini-2.0-flash-preview');
    assert.equal(r.normalized, 'gemini-2-0-flash');
  });

  it('collapses underscores to dashes', () => {
    const r = normalizeModelId('llama_3_1_70b');
    assert.equal(r.normalized, 'llama-3-1-70b');
  });

  it('collapses dots to dashes', () => {
    const r = normalizeModelId('glm-4.6');
    assert.equal(r.normalized, 'glm-4-6');
  });
});

describe('scoreMatch', () => {
  it('scores 1.0 for exact raw match', () => {
    const { score } = scoreMatch('glm-4.6', 'glm-4.6');
    assert.equal(score, 1.0);
  });

  it('scores >= 0.9 for normalized name match with vendor prefix', () => {
    const { score } = scoreMatch('kimi-k2.6', 'moonshotai/kimi-k2.6');
    assert.ok(score >= 0.9, `expected >= 0.9, got ${score}`);
  });

  it('scores >= 0.9 for bare vs prefixed same model', () => {
    const { score } = scoreMatch('glm-4.6', 'zhipu/glm-4.6');
    assert.ok(score >= 0.9, `expected >= 0.9, got ${score}`);
  });

  it('scores < 0.75 for completely unrelated models', () => {
    const { score } = scoreMatch('claude-opus-4', 'llama-3.1-70b');
    assert.ok(score < 0.75, `expected < 0.75, got ${score}`);
  });

  it('is case-insensitive', () => {
    const { score } = scoreMatch('GLM-4.6', 'glm-4.6');
    assert.equal(score, 1.0);
  });

  it('gives vendor alias bonus for moonshotai/kimi', () => {
    const withVendor = scoreMatch('claude-3-5-sonnet-latest', 'moonshotai/kimi-k2.6');
    const noVendor = scoreMatch('claude-3-5-sonnet-latest', 'kimi-k2.6');
    // Both may be below threshold but vendor match should add bonus
    assert.ok(withVendor.score >= noVendor.score, 'vendor alias should not hurt score');
  });
});

describe('computePrefixStyle', () => {
  it('returns prefixed when all model IDs have vendor prefix', () => {
    assert.equal(computePrefixStyle(['a/b', 'c/d', 'e/f']), 'prefixed');
  });

  it('returns bare when no model IDs have vendor prefix', () => {
    assert.equal(computePrefixStyle(['ab', 'cd', 'ef']), 'bare');
  });

  it('returns mixed when split between prefixed and bare', () => {
    assert.equal(computePrefixStyle(['a/b', 'cd', 'e/f', 'gh']), 'mixed');
  });

  it('returns bare for empty list', () => {
    assert.equal(computePrefixStyle([]), 'bare');
  });

  it('returns prefixed when >= 80% have prefix', () => {
    assert.equal(computePrefixStyle(['a/b', 'c/d', 'e/f', 'g/h', 'bare']), 'prefixed');
  });
});

describe('buildSuggestions', () => {
  it('suggests prefixed ID for bare mapping', () => {
    const mappings = { 'claude-3-5-sonnet-latest': 'kimi-k2.6' };
    const models = ['moonshotai/kimi-k2.6', 'openai/gpt-4o'];
    const sug = buildSuggestions(mappings, models);
    assert.equal(sug.length, 1);
    assert.equal(sug[0].claudeModel, 'claude-3-5-sonnet-latest');
    assert.equal(sug[0].suggested, 'moonshotai/kimi-k2.6');
    assert.ok(sug[0].confidence >= 0.75);
  });

  it('marks alreadyCorrect when current matches suggestion', () => {
    const mappings = { 'claude-3-5-sonnet-latest': 'moonshotai/kimi-k2.6' };
    const models = ['moonshotai/kimi-k2.6'];
    const sug = buildSuggestions(mappings, models);
    assert.equal(sug.length, 1);
    assert.equal(sug[0].alreadyCorrect, true);
  });

  it('returns empty when no models match above threshold', () => {
    const mappings = { 'claude-opus-4': 'completely-unrelated-model' };
    const models = ['llama-3.1-70b', 'mistral-7b'];
    const sug = buildSuggestions(mappings, models);
    assert.equal(sug.length, 0);
  });

  it('handles multiple mappings correctly', () => {
    const mappings = {
      'claude-haiku-4': 'glm-4.6',
      'claude-sonnet-4': 'glm-4.6',
    };
    const models = ['zhipu/glm-4.6', 'openai/gpt-4o'];
    const sug = buildSuggestions(mappings, models);
    // Both should suggest zhipu/glm-4.6
    assert.ok(sug.length >= 1);
    sug.forEach((s) => assert.equal(s.suggested, 'zhipu/glm-4.6'));
  });
});
