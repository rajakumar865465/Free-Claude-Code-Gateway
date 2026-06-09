import type { AutoMapSuggestion, AutoMapResult } from '../types/config';

export interface NormalizedModel {
  rawId: string;
  vendor: string | null;
  name: string;
  normalized: string;
}

export type PrefixStyle = 'prefixed' | 'bare' | 'mixed';

const STRIP_SUFFIXES = [
  '-latest', '-preview', '-turbo', '-instruct', '-chat',
  '-fast', '-mini', '-nano', '-lite', '-pro', '-max',
];

export const VENDOR_ALIASES: Record<string, string[]> = {
  'moonshotai':  ['kimi'],
  'anthropic':   ['claude'],
  'openai':      ['gpt', 'o1', 'o3', 'o4'],
  'meta-llama':  ['llama'],
  'mistralai':   ['mistral', 'mixtral', 'codestral'],
  'google':      ['gemini', 'gemma'],
  'deepseek-ai': ['deepseek'],
  'qwen':        ['qwen'],
  'minimax':     ['minimax', 'm2'],
  'zhipu':       ['glm'],
  'z-ai':        ['glm'],
};

export const CONFIDENCE_THRESHOLD = 0.75;

export function normalizeModelId(rawId: string): NormalizedModel {
  const lower = rawId.toLowerCase();
  let vendor: string | null = null;
  let name = lower;

  if (lower.includes('/')) {
    const slash = lower.indexOf('/');
    vendor = lower.slice(0, slash);
    name = lower.slice(slash + 1);
  }

  for (const suffix of STRIP_SUFFIXES) {
    if (name.endsWith(suffix)) {
      name = name.slice(0, -suffix.length);
      break;
    }
  }

  const normalized = name.replace(/[_.]/g, '-');

  return { rawId, vendor, name: normalized, normalized };
}

function tokenize(s: string): Set<string> {
  return new Set(s.split('-').filter((t) => t.length > 0));
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1.0;
  const intersection = [...a].filter((t) => b.has(t)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

function vendorAliasBonus(
  claudeNorm: NormalizedModel,
  providerNorm: NormalizedModel,
): number {
  if (!providerNorm.vendor) return 0;
  const aliases = VENDOR_ALIASES[providerNorm.vendor];
  if (!aliases) return 0;
  for (const alias of aliases) {
    if (claudeNorm.normalized.includes(alias) || providerNorm.normalized.includes(alias)) {
      return 0.1;
    }
  }
  return 0;
}

function sizeTierBonus(a: NormalizedModel, b: NormalizedModel): number {
  const sizePattern = /\b(\d+\.?\d*[bk][\d.]*|\d+b)\b/gi;
  const aTokens = (a.rawId + ' ' + a.normalized).match(sizePattern)?.map((t) => t.toLowerCase()) ?? [];
  const bTokens = (b.rawId + ' ' + b.normalized).match(sizePattern)?.map((t) => t.toLowerCase()) ?? [];
  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);
  const shared = [...aSet].filter((t) => bSet.has(t));
  return shared.length > 0 ? 0.05 : 0;
}

export function scoreMatch(
  claudeModel: string,
  discoveredRawId: string,
): { score: number; reason: string } {
  const cNorm = normalizeModelId(claudeModel);
  const dNorm = normalizeModelId(discoveredRawId);

  if (claudeModel.toLowerCase() === discoveredRawId.toLowerCase()) {
    return { score: 1.0, reason: 'Exact raw match' };
  }

  if (cNorm.normalized === dNorm.normalized) {
    const bonus = vendorAliasBonus(cNorm, dNorm) + sizeTierBonus(cNorm, dNorm);
    return {
      score: Math.min(1.0, 0.9 + bonus),
      reason: `Normalized name match${dNorm.vendor ? '; provider uses vendor-prefixed IDs' : ''}`,
    };
  }

  const cBare = cNorm.normalized;
  const dBare = dNorm.normalized;
  if (cBare === dBare) {
    return { score: 0.85, reason: 'Name match ignoring suffixes' };
  }

  const cTokens = tokenize(cNorm.normalized);
  const dTokens = tokenize(dNorm.normalized);
  const jaccard = jaccardSimilarity(cTokens, dTokens);
  const base = jaccard * 0.7;
  const aliasBonus = vendorAliasBonus(cNorm, dNorm);
  const sizeBonus = sizeTierBonus(cNorm, dNorm);
  const total = Math.min(1.0, base + aliasBonus + sizeBonus);

  const reason = jaccard > 0
    ? `Token similarity ${(jaccard * 100).toFixed(0)}%${aliasBonus > 0 ? '; vendor alias match' : ''}`
    : 'Low similarity';

  return { score: total, reason };
}

export function computePrefixStyle(modelIds: string[]): PrefixStyle {
  if (modelIds.length === 0) return 'bare';
  const prefixed = modelIds.filter((id) => id.includes('/')).length;
  const ratio = prefixed / modelIds.length;
  if (ratio >= 0.8) return 'prefixed';
  if (ratio < 0.2) return 'bare';
  return 'mixed';
}

export function buildSuggestions(
  mappings: Record<string, string>,
  availableModels: string[],
): AutoMapSuggestion[] {
  const suggestions: AutoMapSuggestion[] = [];

  for (const [claudeModel, currentValue] of Object.entries(mappings)) {
    let bestScore = 0;
    let bestRaw = '';
    let bestReason = '';

    for (const rawId of availableModels) {
      // Score both by Claude model name AND current mapped value — take the best
      const byClaudeModel = scoreMatch(claudeModel, rawId);
      const byCurrentValue = scoreMatch(currentValue, rawId);
      const { score, reason } = byCurrentValue.score >= byClaudeModel.score
        ? byCurrentValue
        : byClaudeModel;

      if (score > bestScore) {
        bestScore = score;
        bestRaw = rawId;
        bestReason = reason;
      }
    }

    if (bestScore >= CONFIDENCE_THRESHOLD) {
      suggestions.push({
        claudeModel,
        current: currentValue,
        suggested: bestRaw,
        confidence: bestScore,
        reason: bestReason,
        alreadyCorrect: currentValue === bestRaw,
      });
    }
  }

  return suggestions;
}
