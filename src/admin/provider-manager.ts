import { loadJson, saveJson } from './persist';
import { getConfig } from '../config/env';
import type { FamilyRule } from '../types/config';

/** Fixed Databricks base URL - all Databricks providers use this endpoint */
export const DATABRICKS_BASE_URL = 'https://dbc-def4da34-c29a.cloud.databricks.com/ai-gateway/mlflow/v1';

export interface Provider {
  id: string;
  name: string;
  type?: string; // Provider type: 'openai', 'databricks', 'aws_bedrock', 'azure_foundry', etc.
  baseUrl: string;
  /** API key — stored on disk, never sent to browser in full */
  apiKey: string;
  defaultModel: string;
  models?: string[];
  notes: string;
  createdAt: string;
  // AWS Bedrock specific fields
  awsRegion?: string;
  // Azure AI Foundry specific fields
  azureApiVersion?: string;
  azureApiFlavor?: 'chat_completions' | 'responses';
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
  type?: string; // Provider type
  baseUrl: string;
  /** Redacted key preview e.g. "sk-...xyz" */
  apiKeyPreview: string;
  apiKeySet: boolean;
  defaultModel: string;
  models: string[];
  notes: string;
  createdAt: string;
  /** Whether this provider has a saved model snapshot */
  hasModelSnapshot: boolean;
  // AWS Bedrock specific fields
  awsRegion?: string;
  // Azure AI Foundry specific fields
  azureApiVersion?: string;
  azureApiFlavor?: 'chat_completions' | 'responses';
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
  const models = Array.isArray(p.models) && p.models.length > 0
    ? p.models
    : (p.defaultModel ? [p.defaultModel] : []);
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    baseUrl: p.baseUrl,
    apiKeyPreview: p.apiKey ? redactKey(p.apiKey) : '',
    apiKeySet: p.apiKey.length > 0,
    defaultModel: p.defaultModel,
    models,
    notes: p.notes,
    createdAt: p.createdAt,
    hasModelSnapshot: modelSnapshots.has(p.id),
    // AWS Bedrock fields
    awsRegion: p.awsRegion,
    // Azure AI Foundry fields
    azureApiVersion: p.azureApiVersion,
    azureApiFlavor: p.azureApiFlavor,
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

  getAll(): Provider[] {
    return [...this.providers];
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
    const type = validated.type ?? 'openai-compatible'; // Default to openai-compatible for backward compatibility
    // For Databricks, use the fixed base URL
    const baseUrl = type === 'databricks' 
      ? DATABRICKS_BASE_URL
      : (validated.baseUrl || '');
    const apiKey = validated.apiKey ?? '';
    const defaultModel = validated.defaultModel!;
    const id = uniqueId(this.providers.map((p) => p.id), slugify(name));
    
    const models = validated.models ?? (defaultModel ? [defaultModel] : []);
    const provider: Provider = {
      id,
      name,
      type,
      baseUrl,
      apiKey,
      defaultModel,
      models,
      notes: validated.notes,
      createdAt: new Date().toISOString(),
      // AWS Bedrock fields
      awsRegion: validated.awsRegion,
      // Azure AI Foundry fields
      azureApiVersion: validated.azureApiVersion,
      azureApiFlavor: validated.azureApiFlavor || 'chat_completions',
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
    const updatedType = validated.type ?? existing.type ?? 'openai-compatible';
    // For Databricks, always use the fixed base URL, ignoring any provided baseUrl
    const updatedBaseUrl = updatedType === 'databricks'
      ? DATABRICKS_BASE_URL
      : (validated.baseUrl ?? existing.baseUrl);
    
    const updatedModels = validated.models !== undefined
      ? validated.models
      : (existing.models ?? (validated.defaultModel ? [validated.defaultModel] : (existing.defaultModel ? [existing.defaultModel] : [])));

    this.providers[idx] = {
      ...existing,
      name: validated.name ?? existing.name,
      type: updatedType,
      baseUrl: updatedBaseUrl,
      // Only replace key if explicitly provided (non-empty string)
      apiKey: validated.apiKey !== undefined && validated.apiKey !== ''
        ? validated.apiKey
        : existing.apiKey,
      defaultModel: validated.defaultModel ?? existing.defaultModel,
      models: updatedModels,
      notes: validated.notes ?? existing.notes,
      // AWS Bedrock fields - update if provided
      awsRegion: validated.awsRegion ?? existing.awsRegion,
      // Azure AI Foundry fields - update if provided
      azureApiVersion: validated.azureApiVersion ?? existing.azureApiVersion,
      azureApiFlavor: validated.azureApiFlavor ?? existing.azureApiFlavor,
    };
    this.persist();
    return toSnapshot(this.providers[idx], this.modelSnapshots);
  }

  setProviderModels(id: string, models: string[]): void {
    const p = this.providers.find((x) => x.id === id);
    if (!p) return;
    p.models = [...new Set(models.filter((m) => typeof m === 'string' && m.trim().length > 0))];
    this.persist();
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
  ): { 
    name?: string; 
    type?: string; 
    baseUrl?: string; 
    apiKey?: string; 
    defaultModel?: string; 
    models?: string[];
    notes: string;
    awsRegion?: string;
    awsAccessKeyId?: string;
    awsSecretAccessKey?: string;
    awsSessionToken?: string;
    awsAuthMethod?: 'access_keys' | 'iam_role';
    azureApiVersion?: string;
    azureApiFlavor?: 'chat_completions' | 'responses';
  } {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new ProviderValidationError('Body must be a JSON object.');
    }
    const p = input as Record<string, unknown>;
    const out: { 
      name?: string; 
      type?: string; 
      baseUrl?: string; 
      apiKey?: string; 
      defaultModel?: string; 
      models?: string[];
      notes: string;
      awsRegion?: string;
      awsAccessKeyId?: string;
      awsSecretAccessKey?: string;
      awsSessionToken?: string;
      awsAuthMethod?: 'access_keys' | 'iam_role';
      azureApiVersion?: string;
      azureApiFlavor?: 'chat_completions' | 'responses';
    } = {
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

    if ('type' in p) {
      const v = p.type;
      if (typeof v !== 'string' || v.trim().length === 0) {
        throw new ProviderValidationError('type must be a non-empty string.');
      }
      const validTypes = ['openai-compatible', 'openai', 'anthropic', 'google-gemini', 'groq', 'openrouter', 'databricks', 'aws_bedrock', 'azure_foundry'];
      if (!validTypes.includes(v.trim().toLowerCase())) {
        throw new ProviderValidationError(`type must be one of: ${validTypes.join(', ')}`);
      }
      out.type = v.trim().toLowerCase();
    }

    if ('baseUrl' in p) {
      const v = p.baseUrl;
      const providerType = out.type || 'openai-compatible';
      
      // Allow empty baseUrl for aws_bedrock and databricks (backend constructs URL)
      if (typeof v === 'string' && v.trim().length === 0 && (providerType === 'aws_bedrock' || providerType === 'databricks')) {
        out.baseUrl = '';
      } else if (typeof v !== 'string' || !/^https?:\/\//i.test(v.trim())) {
        throw new ProviderValidationError('baseUrl must start with http:// or https://');
      } else {
        out.baseUrl = v.trim().replace(/\/+$/, '');
      }
    } else if (!partial) {
      // baseUrl is required for openai-compatible, optional for built-in providers, and ignored for databricks/aws_bedrock
      const providerType = out.type || 'openai-compatible';
      if (providerType === 'openai-compatible') {
        throw new ProviderValidationError('baseUrl is required for custom providers.');
      }
      // For databricks, aws_bedrock, and built-in providers, set empty baseUrl (will use predefined endpoints)
      out.baseUrl = '';
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

    if ('models' in p) {
      if (Array.isArray(p.models)) {
        out.models = p.models
          .map((m) => String(m).trim())
          .filter((m) => m.length > 0);
      } else if (typeof p.models === 'string') {
        out.models = p.models
          .split(/[\n,]+/)
          .map((m) => m.trim())
          .filter((m) => m.length > 0);
      }
    }

    if ('notes' in p && typeof p.notes === 'string') {
      out.notes = p.notes.trim().slice(0, 500);
    }

    // ── AWS Bedrock specific validation ──────────────────────────
    if (out.type === 'aws_bedrock') {
      // Validate AWS Region
      if ('awsRegion' in p) {
        const v = p.awsRegion;
        if (typeof v !== 'string' || v.trim().length === 0) {
          throw new ProviderValidationError('awsRegion is required for AWS Bedrock');
        }
        out.awsRegion = v.trim();
      } else if (!partial) {
        throw new ProviderValidationError('awsRegion is required for AWS Bedrock');
      }

      // AWS Bedrock doesn't use baseUrl (will be constructed from region)
      out.baseUrl = '';
    }

    // ── Azure AI Foundry specific validation ─────────────────────
    if (out.type === 'azure_foundry') {
      // Azure requires a baseUrl (the endpoint URL)
      if (!out.baseUrl && !partial) {
        throw new ProviderValidationError('Endpoint URL is required for Azure AI Foundry.');
      }
      // Validate and store API version
      if ('azureApiVersion' in p) {
        const v = p.azureApiVersion;
        if (typeof v === 'string' && v.trim().length > 0) {
          out.azureApiVersion = v.trim();
        }
      }
      if ('azureApiFlavor' in p) {
        const flavor = p.azureApiFlavor;
        if (flavor === 'chat_completions' || flavor === 'responses') {
          out.azureApiFlavor = flavor;
        } else {
          throw new ProviderValidationError("azureApiFlavor must be 'chat_completions' or 'responses'");
        }
      }
      // Default API version if not provided
      if (!out.azureApiVersion && !partial) {
        out.azureApiVersion = '2024-05-01-preview';
      }
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
