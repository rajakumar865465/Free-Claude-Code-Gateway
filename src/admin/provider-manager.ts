import { loadJson, saveJson } from './persist';
import { getConfig } from '../config/env';
import type { FamilyRule } from '../types/config';

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  /** API key — stored on disk, never sent to browser in full */
  apiKey: string;
  defaultModel: string;
  notes: string;
  createdAt: string;
}

/** Per-provider model routing snapshot — saved when switching away, restored when switching back */
export interface ProviderModelSnapshot {
  mappings: Record<string, string>;
  familyRules: FamilyRule[];
  defaultModel: string;
  savedAt: string;
}

export interface ProviderSnapshot {
  id: string;
  name: string;
  baseUrl: string;
  /** Redacted key preview e.g. "sk-...xyz" */
  apiKeyPreview: string;
  apiKeySet: boolean;
  defaultModel: string;
  notes: string;
  createdAt: string;
  /** Whether this provider has a saved model snapshot */
  hasModelSnapshot: boolean;
}

export interface ProvidersPayload {
  activeId: string | null;
  providers: ProviderSnapshot[];
}

export class ProviderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderValidationError';
  }
}

const STORAGE_KEY = 'providers';
const SNAPSHOTS_KEY = 'provider-model-snapshots';

interface StoredData {
  activeId?: string | null;
  providers?: Provider[];
}

function redactKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function toSnapshot(p: Provider, modelSnapshots: Map<string, ProviderModelSnapshot>): ProviderSnapshot {
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    apiKeyPreview: p.apiKey ? redactKey(p.apiKey) : '',
    apiKeySet: p.apiKey.length > 0,
    defaultModel: p.defaultModel,
    notes: p.notes,
    createdAt: p.createdAt,
    hasModelSnapshot: modelSnapshots.has(p.id),
  };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || `provider-${Date.now()}`;
}

function uniqueId(existing: string[], base: string): string {
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export class ProviderManager {
  private providers: Provider[] = [];
  private activeId: string | null = null;
  /** Per-provider saved model routing state */
  private modelSnapshots: Map<string, ProviderModelSnapshot> = new Map();

  constructor() {
    const stored = loadJson<StoredData>(STORAGE_KEY, {});
    this.providers = stored.providers ?? [];
    this.activeId = stored.activeId ?? null;

    // Load per-provider model snapshots
    const storedSnaps = loadJson<Record<string, ProviderModelSnapshot>>(SNAPSHOTS_KEY, {});
    for (const [id, snap] of Object.entries(storedSnaps)) {
      this.modelSnapshots.set(id, snap);
    }

    // If active points to a deleted provider, clear it
    if (this.activeId && !this.providers.find((p) => p.id === this.activeId)) {
      this.activeId = null;
    }
  }

  // ── Reads ─────────────────────────────────────────────────────

  snapshot(): ProvidersPayload {
    return {
      activeId: this.activeId,
      providers: this.providers.map((p) => toSnapshot(p, this.modelSnapshots)),
    };
  }

  getActive(): Provider | null {
    if (!this.activeId) return null;
    return this.providers.find((p) => p.id === this.activeId) ?? null;
  }

  getActiveApiKey(): string {
    const p = this.getActive();
    if (p) return p.apiKey;
    return getConfig().bluesmindsApiKey;
  }

  getActiveBaseUrl(): string {
    const p = this.getActive();
    if (p) return p.baseUrl.replace(/\/+$/, '');
    return getConfig().bluesmindsBaseUrl.replace(/\/+$/, '');
  }

  getActiveDefaultModel(): string {
    const p = this.getActive();
    if (p && p.defaultModel) return p.defaultModel;
    return getConfig().defaultModel;
  }

  getById(id: string): Provider | undefined {
    return this.providers.find((p) => p.id === id);
  }

  /**
   * Get the saved model snapshot for a provider (if any).
   * Returns null if no snapshot has been saved yet.
   */
  getModelSnapshot(id: string): ProviderModelSnapshot | null {
    return this.modelSnapshots.get(id) ?? null;
  }

  // ── Mutations ─────────────────────────────────────────────────

  add(input: unknown): ProviderSnapshot {
    const validated = this.validateInput(input);
    const name = validated.name!;
    const baseUrl = validated.baseUrl!;
    const apiKey = validated.apiKey ?? '';
    const defaultModel = validated.defaultModel!;
    const id = uniqueId(this.providers.map((p) => p.id), slugify(name));
    const provider: Provider = {
      id,
      name,
      baseUrl,
      apiKey,
      defaultModel,
      notes: validated.notes,
      createdAt: new Date().toISOString(),
    };
    this.providers.push(provider);
    this.persist();
    return toSnapshot(provider, this.modelSnapshots);
  }

  update(id: string, input: unknown): ProviderSnapshot {
    const idx = this.providers.findIndex((p) => p.id === id);
    if (idx < 0) throw new ProviderValidationError(`Provider "${id}" not found.`);
    const validated = this.validateInput(input, true);
    const existing = this.providers[idx];
    this.providers[idx] = {
      ...existing,
      name: validated.name ?? existing.name,
      baseUrl: validated.baseUrl ?? existing.baseUrl,
      // Only replace key if explicitly provided (non-empty string)
      apiKey: validated.apiKey !== undefined && validated.apiKey !== ''
        ? validated.apiKey
        : existing.apiKey,
      defaultModel: validated.defaultModel ?? existing.defaultModel,
      notes: validated.notes ?? existing.notes,
    };
    this.persist();
    return toSnapshot(this.providers[idx], this.modelSnapshots);
  }

  delete(id: string): void {
    const idx = this.providers.findIndex((p) => p.id === id);
    if (idx < 0) throw new ProviderValidationError(`Provider "${id}" not found.`);
    if (this.activeId === id) {
      throw new ProviderValidationError(
        'Cannot delete the active provider. Switch to another provider first.',
      );
    }
    this.providers.splice(idx, 1);
    // Clean up saved snapshot for deleted provider
    this.modelSnapshots.delete(id);
    this.persist();
    this.persistSnapshots();
  }

  /**
   * Save the current Model Router state (mappings + family rules + default) for
   * a specific provider.  Called before switching away from that provider so the
   * state can be restored when switching back.
   */
  saveModelSnapshot(
    providerId: string,
    mappings: Record<string, string>,
    familyRules: FamilyRule[],
    defaultModel: string,
  ): void {
    if (!this.providers.find((p) => p.id === providerId)) return;
    this.modelSnapshots.set(providerId, {
      mappings,
      familyRules,
      defaultModel,
      savedAt: new Date().toISOString(),
    });
    this.persistSnapshots();
  }

  setActive(id: string | null): ProvidersPayload {
    if (id !== null) {
      const found = this.providers.find((p) => p.id === id);
      if (!found) throw new ProviderValidationError(`Provider "${id}" not found.`);
    }
    this.activeId = id;
    this.persist();
    return this.snapshot();
  }

  // ── Validation ────────────────────────────────────────────────

  private validateInput(
    input: unknown,
    partial = false,
  ): { name?: string; baseUrl?: string; apiKey?: string; defaultModel?: string; notes: string } {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new ProviderValidationError('Body must be a JSON object.');
    }
    const p = input as Record<string, unknown>;
    const out: { name?: string; baseUrl?: string; apiKey?: string; defaultModel?: string; notes: string } = {
      notes: '',
    };

    if ('name' in p) {
      const v = p.name;
      if (typeof v !== 'string' || v.trim().length === 0) {
        throw new ProviderValidationError('name must be a non-empty string.');
      }
      out.name = v.trim();
    } else if (!partial) {
      throw new ProviderValidationError('name is required.');
    }

    if ('baseUrl' in p) {
      const v = p.baseUrl;
      if (typeof v !== 'string' || !/^https?:\/\//i.test(v.trim())) {
        throw new ProviderValidationError('baseUrl must start with http:// or https://');
      }
      out.baseUrl = v.trim().replace(/\/+$/, '');
    } else if (!partial) {
      throw new ProviderValidationError('baseUrl is required.');
    }

    if ('apiKey' in p) {
      const v = p.apiKey;
      if (typeof v !== 'string') {
        throw new ProviderValidationError('apiKey must be a string.');
      }
      out.apiKey = v.trim();
    } else if (!partial) {
      out.apiKey = '';
    }

    if ('defaultModel' in p) {
      const v = p.defaultModel;
      if (typeof v !== 'string' || v.trim().length === 0) {
        throw new ProviderValidationError('defaultModel must be a non-empty string.');
      }
      out.defaultModel = v.trim();
    } else if (!partial) {
      throw new ProviderValidationError('defaultModel is required.');
    }

    if ('notes' in p && typeof p.notes === 'string') {
      out.notes = p.notes.trim().slice(0, 500);
    }

    return out;
  }

  // ── Persistence ───────────────────────────────────────────────

  private persist(): void {
    const data: StoredData = {
      activeId: this.activeId,
      providers: this.providers,
    };
    saveJson(STORAGE_KEY, data);
  }

  private persistSnapshots(): void {
    const obj: Record<string, ProviderModelSnapshot> = {};
    for (const [id, snap] of this.modelSnapshots.entries()) {
      obj[id] = snap;
    }
    saveJson(SNAPSHOTS_KEY, obj);
  }
}
