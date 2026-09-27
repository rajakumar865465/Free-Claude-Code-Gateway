import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { GatewayKeyManager } from '../src/admin/gateway-key-manager';
import { buildAuthMiddleware } from '../src/middleware/auth';
import type { AdminState } from '../src/admin/admin-state';

describe('GatewayKeyManager', () => {
  let tmpDir: string;
  let storageFile: string;
  let keyManager: GatewayKeyManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcc-gw-test-'));
    storageFile = path.join(tmpDir, 'gateway-keys.json');
    keyManager = new GatewayKeyManager(storageFile);
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  });

  it('creates a new key with sk-gw- prefix and valid properties', () => {
    const record = keyManager.createKey({
      name: 'Claude Desktop Test',
      expiresInDays: 30,
    });

    assert.ok(record.key, 'Raw key should be returned on creation');
    assert.ok(record.key.startsWith('sk-gw-'), 'Raw key should start with sk-gw-');
    assert.equal(record.snapshot.name, 'Claude Desktop Test');
    assert.equal(record.snapshot.revoked, false);
    assert.equal(record.snapshot.useCount, 0);
    assert.equal(record.snapshot.lastUsedAt, null);
    assert.ok(record.snapshot.keyPreview.startsWith('sk-gw-'));
    assert.ok(record.snapshot.expiresAt !== null);
  });

  it('validates an active key and tracks usage count and timestamp', () => {
    const record = keyManager.createKey({ name: 'Codex Key' });
    const rawKey = record.key;

    assert.equal(keyManager.validateKey(rawKey).valid, true);

    const keys = keyManager.getAll();
    const updated = keys.find((k) => k.id === record.snapshot.id);
    assert.ok(updated);
    assert.equal(updated.useCount, 1);
    assert.ok(updated.lastUsedAt !== null);

    // Second validation increments count
    assert.equal(keyManager.validateKey(rawKey).valid, true);
    const updated2 = keyManager.getAll().find((k) => k.id === record.snapshot.id);
    assert.equal(updated2?.useCount, 2);
  });

  it('rejects an unknown key', () => {
    keyManager.createKey({ name: 'Real Key' });
    assert.equal(keyManager.validateKey('sk-gw-fakekey000000000000000000').valid, false);
    assert.equal(keyManager.validateKey('').valid, false);
  });

  it('rejects a revoked key', () => {
    const record = keyManager.createKey({ name: 'To Revoke' });
    const rawKey = record.key;

    assert.equal(keyManager.validateKey(rawKey).valid, true);

    const revoked = keyManager.revokeKey(record.snapshot.id);
    assert.ok(revoked);
    const result = keyManager.validateKey(rawKey);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'revoked');
  });

  it('rejects an expired key', () => {
    const record = keyManager.createKey({ name: 'Expired Key', expiresInDays: 1 });
    const rawKey = record.key;

    // Artificially expire the key in raw storage to preserve keyHash
    const rawContent = JSON.parse(fs.readFileSync(storageFile, 'utf8'));
    const target = rawContent.find((k: any) => k.id === record.snapshot.id);
    if (target) {
      target.expiresAt = new Date(Date.now() - 10000).toISOString();
      fs.writeFileSync(storageFile, JSON.stringify(rawContent, null, 2), 'utf8');
      // Reload manager
      const reloadedManager = new GatewayKeyManager(storageFile);
      const result = reloadedManager.validateKey(rawKey);
      assert.equal(result.valid, false);
      assert.equal(result.reason, 'expired');
    }
  });

  it('deletes a key permanently', () => {
    const record = keyManager.createKey({ name: 'To Delete' });
    assert.equal(keyManager.getAll().length, 1);

    const deleted = keyManager.deleteKey(record.snapshot.id);
    assert.equal(deleted, true);
    assert.equal(keyManager.getAll().length, 0);
  });

  it('persists across instances', () => {
    const record = keyManager.createKey({ name: 'Persistent Key' });
    const rawKey = record.key;

    const manager2 = new GatewayKeyManager(storageFile);
    assert.equal(manager2.getAll().length, 1);
    assert.equal(manager2.validateKey(rawKey).valid, true);
  });
});

describe('Multi-Scheme Auth Middleware', () => {
  let tmpDir: string;
  let storageFile: string;
  let keyManager: GatewayKeyManager;
  let mockState: AdminState;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcc-gw-auth-'));
    storageFile = path.join(tmpDir, 'gateway-keys.json');
    keyManager = new GatewayKeyManager(storageFile);
    mockState = {
      gatewayKeyManager: keyManager,
      configManager: {
        getProxyApiKey: () => undefined,
      },
    } as unknown as AdminState;
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  });

  function createMockReqRes(pathStr: string, headers: Record<string, string> = {}) {
    const req: any = {
      path: pathStr,
      originalUrl: pathStr,
      headers: { ...headers },
      header(name: string) {
        return headers[name.toLowerCase()] ?? headers[name];
      },
      get(name: string) {
        return headers[name.toLowerCase()] ?? headers[name];
      },
    };
    let statusCode = 200;
    let jsonBody: any = null;
    const res: any = {
      status(code: number) {
        statusCode = code;
        return res;
      },
      json(body: any) {
        jsonBody = body;
        return res;
      },
    };
    return { req, res, getStatus: () => statusCode, getBody: () => jsonBody };
  }

  it('allows open access when no gateway keys exist and no PROXY_API_KEY is configured', () => {
    const originalEnv = process.env.PROXY_API_KEY;
    delete process.env.PROXY_API_KEY;

    try {
      const middleware = buildAuthMiddleware(mockState);
      const { req, res } = createMockReqRes('/v1/messages');
      let nextCalled = false;

      middleware(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, true);
    } finally {
      if (originalEnv) process.env.PROXY_API_KEY = originalEnv;
    }
  });

  it('authenticates via Authorization: Bearer <sk-gw-...>', () => {
    const created = keyManager.createKey({ name: 'Claude Desktop' });
    const middleware = buildAuthMiddleware(mockState);
    const { req, res } = createMockReqRes('/v1/messages', {
      authorization: `Bearer ${created.key}`,
    });

    let nextCalled = false;
    middleware(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
  });

  it('authenticates via x-api-key: <sk-gw-...>', () => {
    const created = keyManager.createKey({ name: 'Anthropic Client' });
    const middleware = buildAuthMiddleware(mockState);
    const { req, res } = createMockReqRes('/messages', {
      'x-api-key': created.key,
    });

    let nextCalled = false;
    middleware(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
  });

  it('authenticates via raw Authorization: <sk-gw-...>', () => {
    const created = keyManager.createKey({ name: 'Raw Header' });
    const middleware = buildAuthMiddleware(mockState);
    const { req, res } = createMockReqRes('/v1/chat/completions', {
      authorization: created.key,
    });

    let nextCalled = false;
    middleware(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
  });

  it('returns Anthropic error schema on 401 for /v1/messages and /messages', () => {
    keyManager.createKey({ name: 'Guard Key' });
    const middleware = buildAuthMiddleware(mockState);

    // /v1/messages without auth
    const { req, res, getStatus, getBody } = createMockReqRes('/v1/messages');
    let nextCalled = false;
    middleware(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(getStatus(), 401);
    assert.equal(getBody().type, 'error');
    assert.equal(getBody().error.type, 'authentication_error');

    // /messages alias without auth
    const { req: req2, res: res2, getStatus: getStatus2, getBody: getBody2 } = createMockReqRes('/messages');
    middleware(req2, res2, () => {});
    assert.equal(getStatus2(), 401);
    assert.equal(getBody2().type, 'error');
    assert.equal(getBody2().error.type, 'authentication_error');
  });

  it('returns OpenAI error schema on 401 for /v1/chat/completions and /v1/models', () => {
    keyManager.createKey({ name: 'Guard Key' });
    const middleware = buildAuthMiddleware(mockState);

    // /v1/chat/completions with wrong key
    const { req, res, getStatus, getBody } = createMockReqRes('/v1/chat/completions', {
      authorization: 'Bearer sk-gw-wrongkey',
    });
    let nextCalled = false;
    middleware(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(getStatus(), 401);
    assert.ok(getBody().error);
    assert.equal(getBody().error.code, 'invalid_api_key');
    assert.equal(getBody().error.type, 'invalid_request_error');
  });
});
