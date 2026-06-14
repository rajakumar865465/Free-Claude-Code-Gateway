/**
 * Context Tracker — Tracks token usage per session and triggers auto-compaction.
 *
 * This is the main entry point for the auto-compact system. It intercepts
 * every request, calculates token usage, and:
 *   - Warns when usage approaches the threshold
 *   - Triggers compaction when threshold is exceeded
 *   - Injects session context (summary) on every request after compaction
 *
 * Session identity is derived from a stable key built from:
 *   - The model name
 *   - The first user message content (hashed to 8 chars)
 *
 * This means the same session is tracked across multiple HTTP requests,
 * which is how Claude Code operates (it sends full context every time).
 */

import { createHash } from 'node:crypto';
import type { OpenAIMessage } from '../types/openai';
import type {
  ContextWindow,
  CompactionResult,
  ContextStatusPayload,
} from './types';
import {
  estimateMessagesTokens,
  getModelContextSize,
} from './token-counter';
import { CompactionEngine } from './compaction-engine';
import type { MemoryStore } from './memory-store';
import type { SummarizerConfig } from './summarizer';
import { Summarizer } from './summarizer';
import { getLogger } from '../utils/logger';

// ─── ContextTracker class ─────────────────────────────────────────────────────

export class ContextTracker {
  readonly store: MemoryStore;
  private readonly engine: CompactionEngine;
  private readonly logger = getLogger();

  constructor(store: MemoryStore) {
    this.store = store;
    this.engine = new CompactionEngine(store);
  }

  /**
   * Process a message array before sending to the upstream model.
   *
   * Steps:
   * 1. Derive session ID
   * 2. Estimate current token usage
   * 3. Inject context from previous session summary (if any)
   * 4. Trigger compaction if threshold exceeded
   * 5. Update context window stats
   *
   * Returns the (potentially modified) message array.
   */
  async process(
    messages: OpenAIMessage[],
    model: string,
    summarizerConfig?: SummarizerConfig,
  ): Promise<{
    messages: OpenAIMessage[];
    sessionId: string;
    compactionResult: CompactionResult | null;
    contextWindow: ContextWindow;
  }> {
    const settings = this.store.getSettings();
    const sessionId = this.deriveSessionId(model, messages);
    const maxTokens = getModelContextSize(
      model,
      settings.modelContextSizes,
      settings.defaultContextSize,
    );

    // ── Inject saved context from a previous compaction ──────────────────────
    // If this session had a prior compaction, the summary was stored.
    // We check whether the current messages already contain our injection marker
    // to avoid double-injecting on the same request.
    let processedMessages = messages;
    const existingSummary = this.store.getSummary(sessionId);
    if (
      existingSummary &&
      !this.hasContextInjection(processedMessages)
    ) {
      // Don't inject if the messages already have enough content — the client
      // is managing their own context. Only inject if messages are unusually short
      // relative to what we've seen before (sign of a fresh session with remembered goal).
      const existingWindow = this.store.getContextWindow(sessionId);
      if (existingWindow && messages.length < existingWindow.messageCount * 0.5) {
        processedMessages = this.injectContext(processedMessages, sessionId);
      }
    }

    // ── Estimate current token usage ─────────────────────────────────────────
    const usedTokens = estimateMessagesTokens(processedMessages);
    const usageRatio = usedTokens / maxTokens;

    // ── Build/update context window ───────────────────────────────────────────
    const existingWindow = this.store.getContextWindow(sessionId);
    const contextWindow: ContextWindow = {
      sessionId,
      model,
      maxTokens,
      usedTokens,
      usageRatio,
      compactThreshold: settings.compactThreshold,
      messageCount: processedMessages.length,
      createdAt: existingWindow?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      compactionCount: existingWindow?.compactionCount ?? 0,
      tokensSaved: existingWindow?.tokensSaved ?? 0,
    };

    // ── Check if compaction is needed ─────────────────────────────────────────
    let compactionResult: CompactionResult | null = null;

    if (settings.enabled && this.engine.shouldCompact(contextWindow)) {
      this.logger.info(
        {
          sessionId,
          usedTokens,
          maxTokens,
          usagePercent: Math.round(usageRatio * 100),
          model,
        },
        'auto_compact_triggered',
      );

      const { messages: compactedMessages, result } = await this.engine.compact(
        processedMessages,
        sessionId,
        model,
        maxTokens,
        summarizerConfig,
      );

      processedMessages = compactedMessages;
      compactionResult = result;

      // Update context window stats post-compaction
      const newTokens = estimateMessagesTokens(processedMessages);
      contextWindow.usedTokens = newTokens;
      contextWindow.usageRatio = newTokens / maxTokens;
      contextWindow.messageCount = processedMessages.length;
      contextWindow.compactionCount = (existingWindow?.compactionCount ?? 0) + 1;
      contextWindow.tokensSaved =
        (existingWindow?.tokensSaved ?? 0) + result.tokensSaved;

    } else if (this.engine.shouldWarn(contextWindow)) {
      this.logger.warn(
        {
          sessionId,
          usedTokens,
          maxTokens,
          usagePercent: Math.round(usageRatio * 100),
          threshold: Math.round(settings.compactThreshold * 100),
        },
        'context_approaching_limit',
      );
    }

    // ── Persist context window ────────────────────────────────────────────────
    this.store.saveContextWindow(contextWindow);

    return {
      messages: processedMessages,
      sessionId,
      compactionResult,
      contextWindow,
    };
  }

  /**
   * Force a manual compaction on a specific session or the highest-usage session.
   */
  async forceCompact(
    messages: OpenAIMessage[],
    model: string,
    sessionId?: string,
    level?: 1 | 2 | 3,
    summarizerConfig?: SummarizerConfig,
  ): Promise<{ messages: OpenAIMessage[]; result: CompactionResult }> {
    const settings = this.store.getSettings();
    const resolvedSessionId = sessionId ?? this.deriveSessionId(model, messages);
    const maxTokens = getModelContextSize(
      model,
      settings.modelContextSizes,
      settings.defaultContextSize,
    );

    return this.engine.compact(
      messages,
      resolvedSessionId,
      model,
      maxTokens,
      summarizerConfig,
      level,
    );
  }

  /**
   * Get stats across all tracked sessions.
   */
  getStats(): import('./types').ContextStats {
    const windows = Object.values(this.store.getAllContextWindows());
    const settings = this.store.getSettings();
    const history = this.store.getHistory();

    return {
      activeSessions: windows.length,
      totalCompactions: history.totalCompactions,
      totalTokensSaved: history.totalTokensSaved,
      sessionsNearLimit: windows.filter((w) => w.usageRatio >= settings.warnThreshold).length,
      sessionsOverThreshold: windows.filter((w) => w.usageRatio >= settings.compactThreshold).length,
      lastCompactionAt: history.lastCompactionAt,
    };
  }

  /**
   * Build the payload for GET /admin/api/context.
   */
  getContextStatus(): ContextStatusPayload {
    const windows = Object.values(this.store.getAllContextWindows());
    const settings = this.store.getSettings();
    const history = this.store.getHistory();

    // Compute aggregate token usage across all sessions
    const totalUsed = windows.reduce((sum, w) => sum + w.usedTokens, 0);
    const totalMax = windows.reduce((sum, w) => sum + w.maxTokens, 0);
    const usagePercent = totalMax > 0 ? Math.round((totalUsed / totalMax) * 100) : 0;

    // Sort sessions by usage ratio descending
    const sortedWindows = [...windows].sort((a, b) => b.usageRatio - a.usageRatio);
    const topSessions = sortedWindows.slice(0, 10).map((w) => ({
      sessionId: w.sessionId,
      model: w.model,
      usedTokens: w.usedTokens,
      maxTokens: w.maxTokens,
      usagePercent: Math.round(w.usageRatio * 100),
      messageCount: w.messageCount,
      compactionCount: w.compactionCount,
    }));

    return {
      usedTokens: totalUsed,
      maxTokens: totalMax || settings.defaultContextSize,
      usagePercent,
      compactions: history.totalCompactions,
      tokensSaved: history.totalTokensSaved,
      activeSessions: windows.length,
      sessionsNearLimit: windows.filter((w) => w.usageRatio >= settings.warnThreshold).length,
      enabled: settings.enabled,
      threshold: Math.round(settings.compactThreshold * 100),
      keepRecentMessages: settings.keepRecentMessages,
      lastCompactionAt: history.lastCompactionAt,
      topSessions,
    };
  }

  /**
   * Get the most-used session for manual compaction targeting.
   */
  getHighestUsageSession(): ContextWindow | null {
    const windows = Object.values(this.store.getAllContextWindows());
    if (windows.length === 0) return null;
    return windows.reduce(
      (max, w) => (w.usageRatio > max.usageRatio ? w : max),
      windows[0],
    );
  }

  /**
   * Clear all context tracking for a session.
   */
  clearSession(sessionId: string): void {
    this.store.deleteContextWindow(sessionId);
    this.store.deleteSummary(sessionId);
  }

  /**
   * Clear all context tracking data.
   */
  clearAll(): void {
    this.store.clearAllContextWindows();
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Derive a stable session ID from the model + first user message.
   * This allows the same conversation to be tracked across multiple HTTP requests.
   */
  private deriveSessionId(model: string, messages: OpenAIMessage[]): string {
    // Find the first user message
    const firstUser = messages.find((m) => m.role === 'user');
    const firstContent =
      typeof firstUser?.content === 'string'
        ? firstUser.content
        : Array.isArray(firstUser?.content)
          ? (firstUser.content as Array<{ text?: string }>)
              .map((p) => p.text ?? '')
              .join('')
          : '';

    // Hash the first 200 chars of first user message with the model name
    const key = `${model}:${firstContent.slice(0, 200)}`;
    const hash = createHash('sha256').update(key).digest('hex').slice(0, 12);
    return `${model.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-${hash}`;
  }

  /**
   * Check if messages already contain our context injection marker.
   */
  private hasContextInjection(messages: OpenAIMessage[]): boolean {
    return messages.some((m) => {
      const content = typeof m.content === 'string' ? m.content : '';
      return content.includes('## Session Context (Auto-Compacted)');
    });
  }

  /**
   * Inject the session summary as a user message at the start of the conversation
   * (after system prompts).
   */
  private injectContext(messages: OpenAIMessage[], sessionId: string): OpenAIMessage[] {
    const summary = this.store.getSummary(sessionId);
    if (!summary) return messages;

    const projectState = this.store.getProjectState(sessionId);
    const injectedContent = `${Summarizer.buildContextInjection(summary, projectState)}\n\n> Context automatically restored from previous session.`;

    const systemMessages = messages.filter((m) => m.role === 'system');
    const otherMessages = messages.filter((m) => m.role !== 'system');

    const injectionMsg: OpenAIMessage = {
      role: 'user',
      content: injectedContent,
    };

    return [...systemMessages, injectionMsg, ...otherMessages];
  }
}
