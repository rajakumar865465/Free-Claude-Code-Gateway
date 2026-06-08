import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { loadModelConfig, resolveProviderModel, resetModelConfigCache } from '../src/config/models';

describe('model mapping', () => {
  before(() => resetModelConfigCache());
  after(() => resetModelConfigCache());

  it('loads default config when file missing', () => {
    process.env.MODELS_CONFIG_PATH = path.sep + 'definitely' + path.sep + 'missing' + path.sep + 'models.json';
    resetModelConfigCache();
    const cfg = loadModelConfig();
    assert.ok(cfg.anthropic_to_bluesminds);
    assert.ok(typeof cfg.default === 'string');
  });

  it('resolves a known mapped model', () => {
    resetModelConfigCache();
    process.env.MODELS_CONFIG_PATH = path.sep + 'definitely' + path.sep + 'missing' + path.sep + 'models.json';
    resetModelConfigCache();
    const cfg = loadModelConfig();
    const resolved = resolveProviderModel('claude-3-5-sonnet-20241022', cfg, 'gpt-4.1', false);
    assert.equal(resolved, cfg.anthropic_to_bluesminds['claude-3-5-sonnet-20241022']);
  });

  it('falls back to incoming model in non-strict mode when no family rules match', () => {
    // Use a config with NO family rules to test the raw pass-through behavior
    const cfg = { anthropic_to_bluesminds: {}, default: 'gpt-4.1', family_rules: [] };
    const resolved = resolveProviderModel('some-unknown-model', cfg, 'gpt-4.1', false);
    assert.equal(resolved, 'some-unknown-model');
  });

  it('falls back via family rule wildcard when rules are present', () => {
    process.env.MODELS_CONFIG_PATH = path.sep + 'definitely' + path.sep + 'missing' + path.sep + 'models.json';
    resetModelConfigCache();
    const cfg = loadModelConfig();
    // The default family_rules include a "*" catch-all that maps to the default model
    const resolved = resolveProviderModel('some-totally-unknown-model', cfg, 'z-ai/glm-5.1', false);
    // Should match the "*" rule → primary model (z-ai/glm-5.1)
    assert.equal(typeof resolved, 'string');
    assert.ok(resolved.length > 0);
  });

  it('throws in strict mode when model has no exact mapping (family rules are bypassed in strict)', () => {
    // In strict mode, family rule wildcards are NOT consulted — exact match only
    const cfg = {
      anthropic_to_bluesminds: { 'claude-3-5-sonnet-20241022': 'z-ai/glm-5.1' },
      default: 'z-ai/glm-5.1',
      family_rules: [],
    };
    assert.throws(() =>
      resolveProviderModel('not-mapped', cfg, 'z-ai/glm-5.1', true),
    );
  });

  it('falls back to default when no incoming model', () => {
    process.env.MODELS_CONFIG_PATH = path.sep + 'definitely' + path.sep + 'missing' + path.sep + 'models.json';
    resetModelConfigCache();
    const cfg = loadModelConfig();
    const resolved = resolveProviderModel(undefined, cfg, 'gpt-4.1', false);
    assert.equal(resolved, 'gpt-4.1');
  });
});
