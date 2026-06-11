import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FamilyRule, ModelMappingConfig, ResolvedModel } from '../types/config';

// ---------------------------------------------------------------------------
// Default config — all Claude models → z-ai/glm-5.1 (BluesMinds provider)
// ---------------------------------------------------------------------------

export const DEFAULT_FAMILY_RULES: FamilyRule[] = [
  { name: 'Haiku',        pattern: 'claude*haiku*',  primary: 'z-ai/glm-5.1', backup: 'z-ai/glm-5.1' },
  { name: 'Sonnet',       pattern: 'claude*sonnet*', primary: 'z-ai/glm-5.1', backup: 'z-ai/glm-5.1' },
  { name: 'Opus',         pattern: 'claude*opus*',   primary: 'z-ai/glm-5.1', backup: 'z-ai/glm-5.1' },
  { name: 'Claude Other', pattern: 'claude*',        primary: 'z-ai/glm-5.1', backup: 'z-ai/glm-5.1' },
  { name: 'Default',      pattern: '*',              primary: 'z-ai/glm-5.1' },
];

const DEFAULT_CONFIG: ModelMappingConfig = {
  anthropic_to_bluesminds: {
    'claude-opus-4-5-20251101': 'z-ai/glm-5.1',
    'claude-3-5-sonnet-latest':   'z-ai/glm-5.1',
    'claude-3-7-sonnet-20250219': 'z-ai/glm-5.1',
    'claude-sonnet-4-20250514':   'z-ai/glm-5.1',
    'claude-opus-4-20250514':     'z-ai/glm-5.1',
    'claude-haiku-4-20250514':    'z-ai/glm-5.1',
    'claude-3-haiku-20240307':    'z-ai/glm-5.1',
  },
  default: 'z-ai/glm-5.1',
  family_rules: DEFAULT_FAMILY_RULES,
};

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

let cachedConfig: ModelMappingConfig | null = null;
let cachedFilePath: string | null = null;

function resolveConfigPath(): string {
  const candidates = [
    process.env.MODELS_CONFIG_PATH,
    path.resolve(process.cwd(), 'config', 'models.json'),
    path.resolve(process.cwd(), '..', 'config', 'models.json'),
    path.resolve(__dirname, '..', '..', 'config', 'models.json'),
  ].filter((p): p is string => Boolean(p));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[1];
}

export function loadModelConfig(): ModelMappingConfig {
  if (cachedConfig) return cachedConfig;

  const filePath = resolveConfigPath();
  cachedFilePath = filePath;

  if (!fs.existsSync(filePath)) {
    cachedConfig = DEFAULT_CONFIG;
    return cachedConfig;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ModelMappingConfig>;
    cachedConfig = {
      anthropic_to_bluesminds: {
        ...DEFAULT_CONFIG.anthropic_to_bluesminds,
        ...(parsed.anthropic_to_bluesminds ?? {}),
      },
      default: parsed.default ?? DEFAULT_CONFIG.default,
      family_rules: parsed.family_rules ?? DEFAULT_FAMILY_RULES,
    };
    return cachedConfig;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load model config at ${filePath}: ${message}`);
  }
}

export function getModelConfigPath(): string {
  if (!cachedFilePath) {
    cachedFilePath = resolveConfigPath();
  }
  return cachedFilePath;
}

// ---------------------------------------------------------------------------
// Glob matching (supports * wildcard only — simple and fast)
// ---------------------------------------------------------------------------

function globMatch(pattern: string, value: string): boolean {
  // Escape all regex special chars except * which becomes .*
  const re = new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
    'i',
  );
  return re.test(value);
}

// ---------------------------------------------------------------------------
// Resolution: exact → family rule → default fallback
// ---------------------------------------------------------------------------

export function resolveProviderModel(
  incoming: string | undefined,
  cfg: ModelMappingConfig,
  fallback: string,
  strict = false,
): string {
  // 1. Exact mapping
  if (incoming && cfg.anthropic_to_bluesminds[incoming]) {
    return cfg.anthropic_to_bluesminds[incoming];
  }

  // 2. Family rules (pattern matching) — skipped in strict mode
  if (incoming && !strict && cfg.family_rules && cfg.family_rules.length > 0) {
    for (const rule of cfg.family_rules) {
      if (rule.pattern && globMatch(rule.pattern, incoming)) {
        return rule.primary;
      }
    }
  }

  // 3. Strict mode — reject unknowns (no exact match found above)
  if (incoming && strict) {
    throw new Error(
      `Model "${incoming}" is not in the strict mapping. Add it to config/models.json.`,
    );
  }

  // 4. Non-strict pass-through (no exact match, no family rule matched)
  if (incoming) return incoming;

  // 4. Use fallback default
  if (fallback) return fallback;
  throw new Error('No model specified and DEFAULT_MODEL is not set.');
}

export function resetModelConfigCache(): void {
  cachedConfig = null;
  cachedFilePath = null;
}

// ---------------------------------------------------------------------------
// Backup-aware resolution
// ---------------------------------------------------------------------------

/**
 * Like resolveProviderModel but also returns the backup model from the matched
 * family rule (if any). Exact mappings and pass-through have no backup.
 */
export function resolveProviderModelWithBackup(
  incoming: string | undefined,
  cfg: ModelMappingConfig,
  fallback: string,
  strict = false,
): ResolvedModel {
  // 1. Exact mapping — no backup concept for exact entries
  if (incoming && cfg.anthropic_to_bluesminds[incoming]) {
    return { primary: cfg.anthropic_to_bluesminds[incoming], backup: null };
  }

  // 2. Family rules (pattern matching) — backup comes from rule
  if (incoming && !strict && cfg.family_rules && cfg.family_rules.length > 0) {
    for (const rule of cfg.family_rules) {
      if (rule.pattern && globMatch(rule.pattern, incoming)) {
        const backup = (rule.backup && rule.backup !== rule.primary) ? rule.backup : null;
        return { primary: rule.primary, backup };
      }
    }
  }

  // 3. Strict mode — reject unknown models
  if (incoming && strict) {
    throw new Error(
      `Model "${incoming}" is not in the strict mapping. Add it to config/models.json.`,
    );
  }

  // 4. Non-strict pass-through
  if (incoming) return { primary: incoming, backup: null };

  // 5. Use fallback default
  if (fallback) return { primary: fallback, backup: null };
  throw new Error('No model specified and DEFAULT_MODEL is not set.');
}
