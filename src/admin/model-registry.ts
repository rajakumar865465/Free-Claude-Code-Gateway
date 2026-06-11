import {
  loadModelConfig,
  resolveProviderModel,
  resolveProviderModelWithBackup,
  resetModelConfigCache,
  DEFAULT_FAMILY_RULES,
} from '../config/models';
import type { FamilyRule, ModelMappingConfig, ResolvedModel } from '../types/config';
import { loadJson, saveJson } from './persist';
import { buildSuggestions, computePrefixStyle, scoreMatch, CONFIDENCE_THRESHOLD } from './model-matcher';
import type { AutoMapSuggestion, AutoMapResult } from '../types/config';

export interface ModelMappingsPayload {
  mappings: Record<string, string>;
  default: string;
  familyRules: FamilyRule[];
}

export class ModelRegistryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelRegistryValidationError';
  }
}

const STORAGE_KEY = 'model-registry';

interface StoredRegistry {
  mappings?: Record<string, string>;
  default?: string;
  familyRules?: FamilyRule[];
}

export class ModelRegistry {
  private overrideMappings: Record<string, string> | null = null;
  private overrideDefault: string | null = null;
  private overrideFamilyRules: FamilyRule[] | null = null;
  private cachedAvailableModels: string[] = [];
  private cachedAvailableAt: Date | null = null;
  private cachedSuggestions: AutoMapSuggestion[] = [];
  private cachedDefaultSuggestion: AutoMapSuggestion | null = null;

  constructor() {
    const stored = loadJson<StoredRegistry>(STORAGE_KEY, {});
    if (stored.mappings && Object.keys(stored.mappings).length > 0) {
      this.overrideMappings = stored.mappings;
    }
    if (stored.default !== undefined) {
      this.overrideDefault = stored.default;
    }
    if (stored.familyRules && stored.familyRules.length > 0) {
      this.overrideFamilyRules = stored.familyRules;
    }
  }

  private currentConfig(): ModelMappingConfig {
    const base = loadModelConfig();
    if (
      this.overrideMappings === null &&
      this.overrideDefault === null &&
      this.overrideFamilyRules === null
    ) {
      return base;
    }
    return {
      anthropic_to_bluesminds: this.overrideMappings ?? base.anthropic_to_bluesminds,
      default: this.overrideDefault ?? base.default ?? '',
      family_rules: this.overrideFamilyRules ?? base.family_rules ?? DEFAULT_FAMILY_RULES,
    };
  }

  snapshot(): ModelMappingsPayload {
    const cfg = this.currentConfig();
    return {
      mappings: { ...cfg.anthropic_to_bluesminds },
      default: cfg.default ?? '',
      familyRules: cfg.family_rules ?? DEFAULT_FAMILY_RULES,
    };
  }

  resolve(incoming: string | undefined, fallback: string, strict = false): string {
    return resolveProviderModel(incoming, this.currentConfig(), fallback, strict);
  }

  resolveWithBackup(incoming: string | undefined, fallback: string, strict = false): ResolvedModel {
    return resolveProviderModelWithBackup(incoming, this.currentConfig(), fallback, strict);
  }

  // ── Exact mappings + default ──────────────────────────────────────────────

  replace(payload: unknown): ModelMappingsPayload {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new ModelRegistryValidationError('Body must be a JSON object with { mappings, default }.');
    }
    const p = payload as Record<string, unknown>;
    const mappingsRaw = p.mappings;
    if (!mappingsRaw || typeof mappingsRaw !== 'object' || Array.isArray(mappingsRaw)) {
      throw new ModelRegistryValidationError('mappings must be a JSON object.');
    }
    const mappings: Record<string, string> = {};
    const entries = Object.entries(mappingsRaw as Record<string, unknown>);
    if (entries.length === 0) {
      throw new ModelRegistryValidationError('mappings must contain at least one entry.');
    }
    for (const [k, v] of entries) {
      if (typeof k !== 'string' || k.length === 0) {
        throw new ModelRegistryValidationError('All mapping keys must be non-empty strings.');
      }
      if (typeof v !== 'string' || v.length === 0) {
        throw new ModelRegistryValidationError(`Mapping value for "${k}" must be a non-empty string.`);
      }
      mappings[k] = v;
    }
    if ('default' in p) {
      const d = p.default;
      if (typeof d !== 'string' || d.length === 0) {
        throw new ModelRegistryValidationError('default must be a non-empty string when provided.');
      }
      this.overrideDefault = d;
    }
    this.overrideMappings = mappings;
    this.persist();
    resetModelConfigCache();
    return this.snapshot();
  }

  // ── Family routing rules ──────────────────────────────────────────────────

  replaceFamilyRules(payload: unknown): ModelMappingsPayload {
    if (!Array.isArray(payload)) {
      throw new ModelRegistryValidationError('Family rules must be a JSON array.');
    }
    const rules: FamilyRule[] = [];
    for (let i = 0; i < payload.length; i++) {
      const r = payload[i] as Record<string, unknown>;
      if (!r || typeof r !== 'object') {
        throw new ModelRegistryValidationError(`rules[${i}] must be an object.`);
      }
      if (typeof r.name !== 'string' || !r.name.trim()) {
        throw new ModelRegistryValidationError(`rules[${i}].name must be a non-empty string.`);
      }
      if (typeof r.pattern !== 'string' || !r.pattern.trim()) {
        throw new ModelRegistryValidationError(`rules[${i}].pattern must be a non-empty string.`);
      }
      if (typeof r.primary !== 'string' || !r.primary.trim()) {
        throw new ModelRegistryValidationError(`rules[${i}].primary must be a non-empty string.`);
      }
      const rule: FamilyRule = {
        name: r.name.trim(),
        pattern: r.pattern.trim(),
        primary: r.primary.trim(),
      };
      if (typeof r.backup === 'string' && r.backup.trim()) {
        rule.backup = r.backup.trim();
      }
      rules.push(rule);
    }
    this.overrideFamilyRules = rules;
    this.persist();
    resetModelConfigCache();
    return this.snapshot();
  }

  /** Update default model only. */
  setDefault(model: string): ModelMappingsPayload {
    if (typeof model !== 'string' || !model.trim()) {
      throw new ModelRegistryValidationError('default must be a non-empty string.');
    }
    this.overrideDefault = model.trim();
    this.persist();
    resetModelConfigCache();
    return this.snapshot();
  }

  // ── Cached model list from provider sync ─────────────────────────────────

  setCachedModels(models: string[]): void {
    this.cachedAvailableModels = models;
    this.cachedAvailableAt = new Date();
    this.cachedSuggestions = [];
    this.cachedDefaultSuggestion = null;
  }

  getCachedModels(): { models: string[]; cachedAt: Date | null } {
    return {
      models: this.cachedAvailableModels,
      cachedAt: this.cachedAvailableAt,
    };
  }

  computeAutoMap(defaultModel: string): AutoMapResult {
    if (this.cachedAvailableModels.length === 0) {
      throw new Error('No models synced. Run Sync Models first.');
    }

    const snap = this.snapshot();
    const prefixStyle = computePrefixStyle(this.cachedAvailableModels);
    const suggestions = buildSuggestions(snap.mappings, this.cachedAvailableModels);

    let defaultSuggestion: AutoMapSuggestion | null = null;
    if (defaultModel) {
      let bestScore = 0;
      let bestRaw = '';
      let bestReason = '';
      for (const rawId of this.cachedAvailableModels) {
        const { score, reason } = scoreMatch(defaultModel, rawId);
        if (score > bestScore) {
          bestScore = score;
          bestRaw = rawId;
          bestReason = reason;
        }
      }
      if (bestScore >= CONFIDENCE_THRESHOLD) {
        defaultSuggestion = {
          claudeModel: '__default__',
          current: defaultModel,
          suggested: bestRaw,
          confidence: bestScore,
          reason: bestReason,
          alreadyCorrect: defaultModel === bestRaw,
        };
      }
    }

    this.cachedSuggestions = suggestions;
    this.cachedDefaultSuggestion = defaultSuggestion;

    const result: AutoMapResult = {
      suggestions,
      defaultSuggestion,
      prefixStyle,
      cachedAt: this.cachedAvailableAt,
    };

    if (prefixStyle === 'mixed') {
      result.mixedWarning = 'This provider returns both prefixed and bare model IDs. Review suggestions carefully.';
    }

    return result;
  }

  applySuggestions(accept: string[] | 'all', defaultModel: string): ModelMappingsPayload {
    if (this.cachedSuggestions.length === 0) {
      throw new ModelRegistryValidationError('No cached suggestions. Run Auto-Map first.');
    }

    const toApply = accept === 'all'
      ? this.cachedSuggestions
      : this.cachedSuggestions.filter((s) => (accept as string[]).includes(s.claudeModel));

    const snap = this.snapshot();
    const newMappings: Record<string, string> = { ...snap.mappings };

    for (const s of toApply) {
      newMappings[s.claudeModel] = s.suggested;
    }

    this.overrideMappings = newMappings;

    if (accept === 'all' && this.cachedDefaultSuggestion && !this.cachedDefaultSuggestion.alreadyCorrect) {
      this.overrideDefault = this.cachedDefaultSuggestion.suggested;
    }

    this.persist();
    resetModelConfigCache();
    this.cachedSuggestions = [];
    this.cachedDefaultSuggestion = null;

    return this.snapshot();
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  private persist(): void {
    const data: StoredRegistry = {};
    if (this.overrideMappings !== null) data.mappings = this.overrideMappings;
    if (this.overrideDefault !== null) data.default = this.overrideDefault;
    if (this.overrideFamilyRules !== null) data.familyRules = this.overrideFamilyRules;
    saveJson(STORAGE_KEY, data);
  }
}
