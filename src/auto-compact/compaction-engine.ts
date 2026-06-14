/**
 * Compaction Engine — Multi-level context compaction logic.
 *
 * Three compaction levels:
 *
 *   Level 1 — Remove tool outputs / large file reads from old messages.
 *              Keeps all user instructions and assistant responses.
 *              Saves 20–40% typically.
 *
 *   Level 2 — Replace oldest messages with a compact summary.
 *              Keeps last N messages intact (configurable, default 20).
 *              Saves 50–75% typically.
 *
 *   Level 3 — Create a fresh context window.
 *              Keeps only: system prompts, latest summary, active task, recent messages.
 *              Used as last resort when L2 is not enough.
 *              Saves 80–95% typically.
 *
 * After compaction, a context injection message is prepended so the model
 * knows exactly where to continue without losing any state.
 */

import { randomUUID } from 'node:crypto';
import type { OpenAIMessage } from '../types/openai';
import type {
  CompactionLevel,
  CompactionResult,
  SessionSummary,
  ProjectState,
  CompactionHistoryEntry,
  ContextWindow,
} from './types';
import {
  estimateMessagesTokens,
  estimateTokens,
  classifyMessage,
} from './token-counter';
import { Summarizer, type SummarizerConfig } from './summarizer';
import type { MemoryStore } from './memory-store';
import { getLogger } from '../utils/logger';

// ─── CompactionEngine ─────────────────────────────────────────────────────────

export class CompactionEngine {
  private readonly store: MemoryStore;
  private readonly logger = getLogger();

  constructor(store: MemoryStore) {
    this.store = store;
  }

  /**
   * Determine which compaction level to apply based on current usage.
   *
   * L1: 80–90% usage (remove tool outputs/file reads)
   * L2: 90–97% usage (summarize + keep recent)
   * L3: 97%+ usage  (full reset with summary + active task only)
   */
  selectLevel(usageRatio: number): CompactionLevel {
    if (usageRatio >= 0.97) return 3;
    if (usageRatio >= 0.90) return 2;
    return 1;
  }

  /**
   * Apply compaction to a message array.
   * Returns the compacted message array and a CompactionResult.
   */
  async compact(
    messages: OpenAIMessage[],
    sessionId: string,
    model: string,
    maxTokens: number,
    summarizerConfig?: SummarizerConfig,
    forceLevel?: CompactionLevel,
  ): Promise<{ messages: OpenAIMessage[]; result: CompactionResult }> {
    const startMs = Date.now();
    const settings = this.store.getSettings();
    const tokensBefore = estimateMessagesTokens(messages);
    const usageRatio = tokensBefore / maxTokens;
    const level = forceLevel ?? this.selectLevel(usageRatio);
    const msgsBefore = messages.length;

    this.logger.info(
      {
        sessionId,
        level,
        tokensBefore,
        maxTokens,
        usageRatio: Math.round(usageRatio * 100),
        messageCount: messages.length,
      },
      'compaction_starting',
    );

    let compactedMessages: OpenAIMessage[] = messages;
    let summary: SessionSummary | null = null;
    let summaryGenerated = false;

    try {
      // ── Generate AI summary (optional, best-effort) ────────────────────────
      if (settings.generateSummary && summarizerConfig) {
        const summarizer = new Summarizer(summarizerConfig);
        summary = await summarizer.summarize(messages, sessionId, level, tokensBefore);
        if (summary) {
          summaryGenerated = true;
          // Update project state with info extracted from summary
          this.updateProjectStateFromSummary(sessionId, summary);
          // Persist the summary
          this.store.saveSummary(summary);
        }
      }

      // ── Apply the appropriate compaction level ─────────────────────────────
      switch (level) {
        case 1:
          compactedMessages = this.applyLevel1(messages, settings.keepRecentMessages);
          break;
        case 2:
          compactedMessages = this.applyLevel2(
            messages,
            settings.keepRecentMessages,
            summary,
            this.store.getProjectState(sessionId),
          );
          break;
        case 3:
          compactedMessages = this.applyLevel3(
            messages,
            summary,
            this.store.getProjectState(sessionId),
          );
          break;
      }

      // ── Ensure we actually reduced tokens ─────────────────────────────────
      // If compaction didn't help much (< 10% reduction), escalate to next level
      const tokensAfterAttempt = estimateMessagesTokens(compactedMessages);
      const reductionRatio = (tokensBefore - tokensAfterAttempt) / tokensBefore;

      if (reductionRatio < 0.10 && level < 3) {
        this.logger.warn(
          { level, reductionRatio, sessionId },
          'compaction_insufficient_escalating',
        );
        const nextLevel = (level + 1) as CompactionLevel;
        switch (nextLevel) {
          case 2:
            compactedMessages = this.applyLevel2(
              messages,
              settings.keepRecentMessages,
              summary,
              this.store.getProjectState(sessionId),
            );
            break;
          case 3:
            compactedMessages = this.applyLevel3(
              messages,
              summary,
              this.store.getProjectState(sessionId),
            );
            break;
        }
      }

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error({ err: errMsg, sessionId, level }, 'compaction_error');

      // Fallback: apply simple L2 without summary
      compactedMessages = this.applyLevel2(messages, settings.keepRecentMessages, null, null);
    }

    const tokensAfter = estimateMessagesTokens(compactedMessages);
    const tokensSaved = Math.max(0, tokensBefore - tokensAfter);
    const durationMs = Date.now() - startMs;

    const result: CompactionResult = {
      sessionId,
      level,
      tokensBeforeCompaction: tokensBefore,
      tokensAfterCompaction: tokensAfter,
      tokensSaved,
      messagesBeforeCompaction: msgsBefore,
      messagesAfterCompaction: compactedMessages.length,
      summaryGenerated,
      compactedAt: new Date().toISOString(),
      durationMs,
    };

    // Record to history
    const historyEntry: CompactionHistoryEntry = {
      id: randomUUID(),
      ...result,
    };
    this.store.recordCompaction(historyEntry);

    this.logger.info(
      {
        sessionId,
        level,
        tokensBefore,
        tokensAfter,
        tokensSaved,
        msgsAfter: compactedMessages.length,
        durationMs,
      },
      'compaction_complete',
    );

    return { messages: compactedMessages, result };
  }

  // ─── Level 1: Remove tool outputs + large file reads ─────────────────────────

  /**
   * L1: Remove tool outputs and large file-read messages from the older
   * portion of the conversation. Keeps user instructions and assistant
   * responses intact. Also keeps the last `keepRecent` messages untouched.
   */
  private applyLevel1(messages: OpenAIMessage[], keepRecent: number): OpenAIMessage[] {
    if (messages.length <= keepRecent) return messages;

    const cutoff = messages.length - keepRecent;
    const result: OpenAIMessage[] = [];

    for (let i = 0; i < messages.length; i++) {
      if (i >= cutoff) {
        // Always keep recent messages
        result.push(messages[i]);
        continue;
      }

      const classified = classifyMessage(messages[i], i);

      if (classified.isToolOutput) {
        // Replace tool output content with a placeholder
        const placeholder = this.buildToolOutputPlaceholder(messages[i], classified.estimatedTokens);
        result.push(placeholder);
      } else if (classified.isFileRead && classified.estimatedTokens > 500) {
        // Replace large file reads with a summary
        const placeholder = this.buildFileReadPlaceholder(messages[i], classified.estimatedTokens);
        result.push(placeholder);
      } else {
        // Keep everything else
        result.push(messages[i]);
      }
    }

    return result;
  }

  private buildToolOutputPlaceholder(msg: OpenAIMessage, originalTokens: number): OpenAIMessage {
    return {
      ...msg,
      content: `[Tool output removed during context compaction. Original: ~${originalTokens} tokens]`,
    };
  }

  private buildFileReadPlaceholder(msg: OpenAIMessage, originalTokens: number): OpenAIMessage {
    const content = typeof msg.content === 'string' ? msg.content : '';
    // Keep just the first line or filename reference
    const firstLine = content.split('\n')[0].slice(0, 100);
    return {
      ...msg,
      content: `[File content removed during context compaction. Reference: "${firstLine}". Original: ~${originalTokens} tokens]`,
    };
  }

  // ─── Level 2: Summarize old messages, keep recent ─────────────────────────────

  /**
   * L2: Replace older messages with a summary message,
   * keeping the last `keepRecent` messages intact.
   */
  private applyLevel2(
    messages: OpenAIMessage[],
    keepRecent: number,
    summary: SessionSummary | null,
    projectState: ProjectState | null,
  ): OpenAIMessage[] {
    if (messages.length <= keepRecent) {
      // If we have a summary, prepend it but keep all messages
      if (summary) {
        const injectionMsg = this.buildSummaryMessage(summary, projectState);
        return [injectionMsg, ...messages];
      }
      return messages;
    }

    // Split: messages to summarize vs messages to keep
    const cutoff = messages.length - keepRecent;
    const toSummarize = messages.slice(0, cutoff);
    const toKeep = messages.slice(cutoff);

    // Extract system messages from the old portion — always preserve them
    const systemMessages = toSummarize.filter((m) => m.role === 'system');

    // Build the injection message
    const injectionMsg = this.buildSummaryMessage(
      summary,
      projectState,
      toSummarize.length,
    );

    // Result: system messages + injection + recent messages
    return [...systemMessages, injectionMsg, ...toKeep];
  }

  private buildSummaryMessage(
    summary: SessionSummary | null,
    projectState: ProjectState | null,
    summarizedCount?: number,
  ): OpenAIMessage {
    let content: string;

    if (summary) {
      content = Summarizer.buildContextInjection(summary, projectState);
    } else {
      // Fallback when no AI summary was generated
      const count = summarizedCount ?? 0;
      content = [
        '## Context Summary (Auto-Compacted)',
        '',
        `> ${count} messages were removed to free up context space.`,
        '> Continuing from where we left off.',
        '',
        'Please continue with the current task. If you need context about previous work,',
        'refer to the conversation history above.',
      ].join('\n');
    }

    return {
      role: 'user',
      content,
    };
  }

  // ─── Level 3: Full context reset ─────────────────────────────────────────────

  /**
   * L3: Create a minimal fresh context with only:
   *   1. All system prompts (never removed)
   *   2. The session summary / context injection
   *   3. The last 5 messages (the "active task")
   */
  private applyLevel3(
    messages: OpenAIMessage[],
    summary: SessionSummary | null,
    projectState: ProjectState | null,
  ): OpenAIMessage[] {
    // Always keep system messages
    const systemMessages = messages.filter((m) => m.role === 'system');

    // Keep only the last 5 messages as the active task context
    const KEEP_LAST = 5;
    const recentMessages = messages.slice(-KEEP_LAST).filter((m) => m.role !== 'system');

    // Build summary injection
    const injectionMsg = this.buildSummaryMessage(summary, projectState, messages.length - KEEP_LAST);

    return [...systemMessages, injectionMsg, ...recentMessages];
  }

  // ─── Project state extraction from summary ────────────────────────────────────

  private updateProjectStateFromSummary(sessionId: string, summary: SessionSummary): void {
    const filePaths = summary.modifiedFiles.map((f) => f.path);
    this.store.updateProjectState(sessionId, {
      allModifiedFiles: filePaths,
      architectureDecisions: summary.architectureDecisions,
      todoItems: summary.pendingTasks,
    });
  }

  /**
   * Check if compaction should be triggered given the current context window.
   */
  shouldCompact(window: ContextWindow): boolean {
    const settings = this.store.getSettings();
    if (!settings.enabled) return false;
    return window.usageRatio >= settings.compactThreshold;
  }

  /**
   * Check if a warning should be emitted (approaching threshold).
   */
  shouldWarn(window: ContextWindow): boolean {
    const settings = this.store.getSettings();
    if (!settings.enabled) return false;
    return (
      window.usageRatio >= settings.warnThreshold &&
      window.usageRatio < settings.compactThreshold
    );
  }
}
