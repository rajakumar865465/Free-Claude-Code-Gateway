import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConfigManager } from '../src/admin/config-manager';
import { getConfig, resetConfigCache } from '../src/config/env';

describe('ConfigManager Settings persistence and env sync', () => {
  const dataDir = path.resolve(process.cwd(), '.blueclaude-data');
  const overrideFile = path.join(dataDir, 'config-overrides.json');
  let backupFileExists = false;
  let backupContent = '';
  // Snapshot of env vars mutated by ConfigManager so we can restore them
  const envSnapshot: Record<string, string | undefined> = {};
  const WATCHED_VARS = ['BLUESMINDS_API_KEY', 'BLUESMINDS_BASE_URL', 'DEFAULT_MODEL',
    'STRICT_MODEL_MAPPING', 'RATE_LIMIT_PER_MINUTE', 'REQUEST_TIMEOUT_MS',
    'MAX_BODY_SIZE', 'DEBUG_LOGS', 'PROXY_API_KEY', 'ALLOWED_ORIGINS'];

  before(() => {
    // Snapshot env before the test suite runs
    for (const key of WATCHED_VARS) envSnapshot[key] = process.env[key];

    // Backup existing overrides file
    if (fs.existsSync(overrideFile)) {
      backupFileExists = true;
      backupContent = fs.readFileSync(overrideFile, 'utf-8');
      fs.unlinkSync(overrideFile);
    }
  });

  after(() => {
    // Restore env vars to prevent test pollution
    for (const key of WATCHED_VARS) {
      if (envSnapshot[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = envSnapshot[key];
      }
    }

    // Restore override file
    if (backupFileExists) {
      fs.writeFileSync(overrideFile, backupContent, 'utf-8');
    } else if (fs.existsSync(overrideFile)) {
      fs.unlinkSync(overrideFile);
    }
    resetConfigCache();
  });

  it('saves and applies API key override', () => {
    const configManager = new ConfigManager();
    const testKey = 'test-new-api-key-' + Date.now();

    configManager.update({
      bluesmindsApiKey: testKey,
    });

    assert.equal(configManager.getApiKey(), testKey);
    assert.equal(getConfig().bluesmindsApiKey, testKey);
  });

  it('loads override from disk on new ConfigManager instantiation', () => {
    // Clear cache and clear env variable to simulate a fresh process start
    resetConfigCache();
    delete process.env.BLUESMINDS_API_KEY;

    // Now instantiate a new ConfigManager, simulating startup
    const configManager = new ConfigManager();

    // Verify it loads the previously saved test key from the previous test
    const storedOverrides = JSON.parse(fs.readFileSync(overrideFile, 'utf-8'));
    assert.ok(storedOverrides.apiKey);
    
    // Check if the getApiKey returns the stored key
    assert.equal(configManager.getApiKey(), storedOverrides.apiKey);

    // CRITICAL CHECK: Does getConfig() return the stored key on startup?
    assert.equal(getConfig().bluesmindsApiKey, storedOverrides.apiKey, 'getConfig().bluesmindsApiKey should match the loaded override key on startup');
  });
});
