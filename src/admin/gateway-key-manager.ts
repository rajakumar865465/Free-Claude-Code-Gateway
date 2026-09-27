import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadJson, saveJson } from './persist';
import { getLogger } from '../utils/logger';

export interface StoredGatewayApiKey {
  id: string;
  name: string;
  keyHash: string;
  keyPreview: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revoked: boolean;
  useCount?: number;
}

export interface GatewayApiKeySnapshot {
  id: string;
  name: string;
  keyPreview: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revoked: boolean;
  useCount?: number;
}

export interface CreateKeyResult {
  key: string;
  snapshot: GatewayApiKeySnapshot;
}

export interface CreateKeyOptions {
  name?: string;
  expiresDays?: number;
  expiresInDays?: number;
}

export interface ValidationResult {
  valid: boolean;
  keyId?: string;
  name?: string;
  reason?: 'missing' | 'invalid' | 'revoked' | 'expired';
}

const STORAGE_KEY = 'gateway-api-keys';

function hashKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey.trim()).digest('hex');
}

export class GatewayKeyManager {
  private keys: StoredGatewayApiKey[] = [];
  private customStoragePath?: string;

  constructor(customStoragePath?: string) {
    if (customStoragePath) {
      this.customStoragePath = customStoragePath;
      if (fs.existsSync(customStoragePath)) {
        try {
          this.keys = JSON.parse(fs.readFileSync(customStoragePath, 'utf8'));
        } catch {
          this.keys = [];
        }
      } else {
        this.keys = [];
      }
    } else {
      this.keys = loadJson<StoredGatewayApiKey[]>(STORAGE_KEY, []);
    }
  }

  private save(): void {
    if (this.customStoragePath) {
      try {
        const dir = path.dirname(this.customStoragePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const tmp = `${this.customStoragePath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.keys, null, 2), 'utf8');
        fs.renameSync(tmp, this.customStoragePath);
      } catch (err) {
        try {
          getLogger().error({ err }, 'gateway_key_custom_save_failed');
        } catch {
          // ignore
        }
      }
    } else {
      saveJson(STORAGE_KEY, this.keys);
    }
  }

  /**
   * Return all stored keys without revealing hashes.
   */
  getAll(): GatewayApiKeySnapshot[] {
    return this.keys.map((k) => ({
      id: k.id,
      name: k.name,
      keyPreview: k.keyPreview,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
      expiresAt: k.expiresAt,
      revoked: k.revoked,
      useCount: k.useCount ?? 0,
    }));
  }

  /**
   * Number of active (non-revoked, non-expired) keys.
   */
  getActiveCount(): number {
    const now = Date.now();
    return this.keys.filter((k) => {
      if (k.revoked) return false;
      if (k.expiresAt && new Date(k.expiresAt).getTime() < now) return false;
      return true;
    }).length;
  }

  /**
   * Total number of keys defined.
   */
  getTotalCount(): number {
    return this.keys.length;
  }

  /**
   * Generate a new Gateway API key.
   * The raw key is returned ONLY once in the return object.
   */
  createKey(
    nameOrOptions: string | CreateKeyOptions,
    expiresDaysArg?: number
  ): CreateKeyResult {
    let name = 'Default Key';
    let expiresDays = expiresDaysArg;

    if (typeof nameOrOptions === 'string') {
      name = nameOrOptions;
    } else if (nameOrOptions && typeof nameOrOptions === 'object') {
      if (nameOrOptions.name) name = nameOrOptions.name;
      expiresDays = nameOrOptions.expiresDays ?? nameOrOptions.expiresInDays;
    }

    const rawKey = `sk-gw-${crypto.randomBytes(24).toString('hex')}`;
    const id = `gwk_${crypto.randomBytes(8).toString('hex')}`;
    const keyHash = hashKey(rawKey);
    const keyPreview = `${rawKey.slice(0, 10)}...${rawKey.slice(-4)}`;
    const createdAt = new Date().toISOString();
    let expiresAt: string | null = null;

    if (expiresDays && expiresDays > 0) {
      const expDate = new Date(Date.now() + expiresDays * 86_400_000);
      expiresAt = expDate.toISOString();
    }

    const stored: StoredGatewayApiKey = {
      id,
      name: name.trim() || 'Default Key',
      keyHash,
      keyPreview,
      createdAt,
      lastUsedAt: null,
      expiresAt,
      revoked: false,
      useCount: 0,
    };

    this.keys.unshift(stored);
    this.save();

    try {
      getLogger().info({ id, name: stored.name, keyPreview }, 'gateway_key_created');
    } catch {
      // ignore
    }

    return {
      key: rawKey,
      snapshot: {
        id: stored.id,
        name: stored.name,
        keyPreview: stored.keyPreview,
        createdAt: stored.createdAt,
        lastUsedAt: stored.lastUsedAt,
        expiresAt: stored.expiresAt,
        revoked: stored.revoked,
        useCount: 0,
      },
    };
  }

  /**
   * Revoke an active key.
   */
  revokeKey(id: string): boolean {
    const key = this.keys.find((k) => k.id === id);
    if (!key) return false;
    key.revoked = true;
    this.save();
    try {
      getLogger().info({ id, name: key.name }, 'gateway_key_revoked');
    } catch {
      // ignore
    }
    return true;
  }

  /**
   * Delete a key permanently.
   */
  deleteKey(id: string): boolean {
    const idx = this.keys.findIndex((k) => k.id === id);
    if (idx < 0) return false;
    this.keys.splice(idx, 1);
    this.save();
    return true;
  }

  /**
   * Constant-time validation of a raw API key.
   * If valid, updates lastUsedAt and useCount.
   */
  validateKey(rawKey: string): ValidationResult {
    if (!rawKey || typeof rawKey !== 'string') {
      return { valid: false, reason: 'missing' };
    }

    const trimmed = rawKey.trim();
    const candidateHash = hashKey(trimmed);
    const candidateBuf = Buffer.from(candidateHash, 'utf8');

    for (const key of this.keys) {
      if (!key.keyHash) continue;
      const storedBuf = Buffer.from(key.keyHash, 'utf8');
      if (candidateBuf.length === storedBuf.length && crypto.timingSafeEqual(candidateBuf, storedBuf)) {
        if (key.revoked) {
          return { valid: false, keyId: key.id, name: key.name, reason: 'revoked' };
        }
        if (key.expiresAt && new Date(key.expiresAt).getTime() < Date.now()) {
          return { valid: false, keyId: key.id, name: key.name, reason: 'expired' };
        }

        // Update lastUsedAt and useCount
        key.lastUsedAt = new Date().toISOString();
        key.useCount = (key.useCount ?? 0) + 1;
        this.save();

        return { valid: true, keyId: key.id, name: key.name };
      }
    }

    return { valid: false, reason: 'invalid' };
  }
}
