/**
 * Token Counter — Estimates token usage for messages and content.
 *
 * Uses a fast approximation (chars / 4) which is accurate to ±10% for
 * most LLM tokenizers. For exact counts we would need a model-specific
 * tokenizer, but this is sufficient for threshold-based compaction decisions.
 *
 * References:
 *  - OpenAI tiktoken: ~4 chars/token on average for English text
 *  - Anthropic: similar ratio for Claude tokenizer
 */

import type { OpenAIMessage } from '../types/openai';
import type { TrackedMessage } from './types';

/** Overhead tokens per message (role label, formatting, separators) */
const MESSAGE_OVERHEAD_TOKENS = 4;

/** Overhead for the entire request (priming tokens, etc.) */
const REQUEST_OVERHEAD_TOKENS = 3;

/**
 * Estimate the number of tokens in a string.
 * Approximation: ~4 characters per token, minimum 1 token.
 */
export function estimateTokens(text: string): number {
  if (!text || typeof text !== 'string') return 0;
  // Rough heuristic: split on whitespace and punctuation, count word-like tokens
  // then add in character-level estimation for better accuracy
  const wordCount = text.split(/\s+/).filter((w) => w.length > 0).length;
  const charEstimate = Math.ceil(text.length / 4);
  // Use average of word count and char estimate
  return Math.max(1, Math.round((wordCount + charEstimate) / 2));
}

/**
 * Estimate token count for a single OpenAI-format message.
 */
export function estimateMessageTokens(msg: OpenAIMessage): number {
  let tokens = MESSAGE_OVERHEAD_TOKENS;

  // Role token
  tokens += 1;

  // Content
  if (typeof msg.content === 'string') {
    tokens += estimateTokens(msg.content);
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part && typeof part === 'object' && 'text' in part) {
        tokens += estimateTokens((part as { text: string }).text);
      }
    }
  }

  // Tool calls in assistant messages
  if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      tokens += estimateTokens(tc.function.name);
      tokens += estimateTokens(tc.function.arguments || '');
      tokens += 4; // overhead per tool call
    }
  }

  return tokens;
}

/**
 * Estimate total token count for an array of messages.
 */
export function estimateMessagesTokens(messages: OpenAIMessage[]): number {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  const messageTokens = messages.reduce(
    (sum, msg) => sum + estimateMessageTokens(msg),
    0,
  );
  return messageTokens + REQUEST_OVERHEAD_TOKENS;
}

/**
 * Classify a message to determine if it's a tool output or file read —
 * these are prime L1 compaction candidates since they're often large
 * and their content is already reflected in later messages.
 */
export function classifyMessage(msg: OpenAIMessage, index: number): TrackedMessage {
  const contentStr =
    typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? (msg.content as Array<{ text?: string }>)
            .map((p) => p.text ?? '')
            .join('\n')
        : '';

  const estimatedTokens = estimateMessageTokens(msg);
  const role = (msg.role as TrackedMessage['role']) || 'user';

  // Tool output detection: role === 'tool' or has tool_call_id
  const isToolOutput =
    role === 'tool' ||
    Boolean((msg as { tool_call_id?: string }).tool_call_id);

  // File read detection: large content blocks that look like file contents
  // Patterns: lines starting with ├──, └──, file paths with extensions,
  // or very long content (> 2000 chars) in a user/tool message
  const isFileRead =
    !isToolOutput &&
    (role === 'user' || role === ('tool' as string)) &&
    (contentStr.length > 2000 ||
      /^\s*(```|---|\+{3}|-{3}|@@)/.test(contentStr) ||
      /\.(ts|js|py|go|rs|java|cpp|c|h|cs|rb|php|swift|kt|json|yaml|yml|toml|xml|html|css|md)\b/.test(
        contentStr,
      ));

  return {
    role,
    content: contentStr,
    estimatedTokens,
    isToolOutput,
    isFileRead,
    originalIndex: index,
  };
}

/**
 * Get estimated context window size (in tokens) for a given model name.
 * Matches against known patterns to find the best estimate.
 */
export function getModelContextSize(
  model: string,
  contextSizes: Record<string, number>,
  defaultSize: number,
): number {
  if (!model) return defaultSize;
  const lower = model.toLowerCase();

  // Exact match first
  if (contextSizes[model]) return contextSizes[model];
  if (contextSizes[lower]) return contextSizes[lower];

  // Pattern match
  for (const [pattern, size] of Object.entries(contextSizes)) {
    if (lower.includes(pattern.toLowerCase())) {
      return size;
    }
  }

  return defaultSize;
}

/**
 * Format a token count as a human-readable string.
 * e.g. 160000 → "160K", 1500000 → "1.5M"
 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${Math.round(n / 1000)}K`;
  }
  return String(n);
}
