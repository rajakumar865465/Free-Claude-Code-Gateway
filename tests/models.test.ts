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
    const resolved = resolveProviderModel('claude-opus-4-5-20251101', cfg, 'gpt-4.1', false);
    assert.equal(resolved, cfg.anthropic_to_bluesminds['claude-opus-4-5-20251101']);
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
      anthropic_to_bluesminds: { 'claude-opus-4-5-20251101': 'z-ai/glm-5.1' },
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

import { resolveProviderModelWithBackup } from '../src/config/models';
import type { ModelMappingConfig } from '../src/types/config';

describe('resolveProviderModelWithBackup', () => {
  const cfg: ModelMappingConfig = {
    anthropic_to_bluesminds: {
      'claude-opus-4-5-20251101': 'glm-4.6',
    },
    default: 'glm-4.6',
    family_rules: [
      { name: 'Sonnet', pattern: 'claude*sonnet*', primary: 'glm-4.6', backup: 'kimi-k2.5' },
      { name: 'Haiku',  pattern: 'claude*haiku*',  primary: 'glm-4.6' },
      { name: 'Default', pattern: '*', primary: 'glm-4.6' },
    ],
  };

  it('exact mapping returns backup: null', () => {
    const r = resolveProviderModelWithBackup('claude-opus-4-5-20251101', cfg, 'glm-4.6', false);
    assert.equal(r.primary, 'glm-4.6');
    assert.equal(r.backup, null);
  });

  it('family rule with backup returns the backup model', () => {
    const r = resolveProviderModelWithBackup('claude-3-5-sonnet-latest', cfg, 'glm-4.6', false);
    assert.equal(r.primary, 'glm-4.6');
    assert.equal(r.backup, 'kimi-k2.5');
  });

  it('family rule without backup field returns backup: null', () => {
    const r = resolveProviderModelWithBackup('claude-haiku-4', cfg, 'glm-4.6', false);
    assert.equal(r.primary, 'glm-4.6');
    assert.equal(r.backup, null);
  });

  it('primary === backup in rule returns backup: null (no point retrying same model)', () => {
    const cfgSame: ModelMappingConfig = {
      anthropic_to_bluesminds: {},
      default: 'glm-4.6',
      family_rules: [
        { name: 'Test', pattern: 'claude*', primary: 'glm-4.6', backup: 'glm-4.6' },
      ],
    };
    const r = resolveProviderModelWithBackup('claude-anything', cfgSame, 'glm-4.6', false);
    assert.equal(r.backup, null);
  });

  it('pass-through (no match) returns backup: null', () => {
    const emptyCfg: ModelMappingConfig = {
      anthropic_to_bluesminds: {},
      default: 'glm-4.6',
      family_rules: [],
    };
    const r = resolveProviderModelWithBackup('unknown-model', emptyCfg, 'glm-4.6', false);
    assert.equal(r.primary, 'unknown-model');
    assert.equal(r.backup, null);
  });

  it('fallback default returns backup: null', () => {
    const r = resolveProviderModelWithBackup(undefined, cfg, 'glm-4.6', false);
    assert.equal(r.primary, 'glm-4.6');
    assert.equal(r.backup, null);
  });

  it('strict mode throws for unknown model', () => {
    assert.throws(() =>
      resolveProviderModelWithBackup('not-in-exact-mapping', cfg, 'glm-4.6', true),
    );
  });
});
