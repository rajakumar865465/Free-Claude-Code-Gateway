/**
 * Summarizer — Generates structured session summaries using the upstream AI.
 *
 * When context compaction is triggered, the summarizer:
 * 1. Takes the full conversation history (or the portion being removed)
 * 2. Sends a special summarization request to the upstream model
 * 3. Parses the response into a structured SessionSummary
 * 4. Returns the summary for storage and context injection
 *
 * The summarization prompt is designed to extract all information needed to
 * continue work seamlessly: goals, completed work, files modified, decisions,
 * open issues, pending tasks, and next action.
 */

import type { OpenAIMessage } from '../types/openai';
import type { SessionSummary, ProjectState, CompactionLevel } from './types';
import { getLogger } from '../utils/logger';

const SUMMARY_SYSTEM_PROMPT = `You are a context compaction assistant. Your job is to analyze a conversation and produce a structured JSON summary that captures all information needed to continue work seamlessly.

The JSON summary must follow this exact structure:
{
  "userGoal": "The main objective the user is trying to accomplish",
  "completedWork": ["task 1", "task 2", ...],
  "modifiedFiles": [{"path": "/src/file.ts", "description": "what was changed"}],
  "architectureDecisions": ["decision 1", "decision 2", ...],
  "currentWork": "What was being done right before this summary",
  "openIssues": ["issue 1", "issue 2", ...],
  "pendingTasks": ["task 1", "task 2", ...],
  "nextAction": "The exact next step to take to continue",
  "notes": "Any other important context, constraints, or preferences"
}

Rules:
- Be extremely specific and detailed in nextAction — it should be immediately actionable
- List ALL files that were mentioned as modified or created
- Capture ALL technical decisions (libraries chosen, patterns used, approaches taken)
- pendingTasks should have enough detail to continue without the original conversation
- openIssues should include error messages, blockers, and unresolved questions
- Respond with ONLY the JSON object, no markdown, no explanation`;

const SUMMARY_USER_PROMPT = (conversationText: string) =>
  `Analyze this conversation and produce a structured JSON summary:\n\n${conversationText}`;

// ─── Summarizer class ─────────────────────────────────────────────────────────

export interface SummarizerConfig {
  /** Base URL of the upstream provider */
  baseUrl: string;
  /** API key for the upstream provider */
  apiKey: string;
  /** Model to use for summarization */
  model: string;
  /** Timeout in ms for the summarization request */
  timeoutMs: number;
}

export class Summarizer {
  private readonly config: SummarizerConfig;
  private readonly logger = getLogger();

  constructor(config: SummarizerConfig) {
    this.config = config;
  }

  /**
   * Generate a structured summary of the given messages.
   * Returns null if summarization fails (compaction can still proceed without a summary).
   */
  async summarize(
    messages: OpenAIMessage[],
    sessionId: string,
    level: CompactionLevel,
    originalTokens: number,
  ): Promise<SessionSummary | null> {
    try {
      const conversationText = this.formatConversationForSummary(messages);

      if (conversationText.length < 100) {
        // Too short to summarize meaningfully
        return this.buildFallbackSummary(sessionId, level, originalTokens, messages);
      }

      const summaryJson = await this.callUpstreamForSummary(conversationText);
      if (!summaryJson) {
        return this.buildFallbackSummary(sessionId, level, originalTokens, messages);
      }

      return this.parseSummaryResponse(summaryJson, sessionId, level, originalTokens);
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err), sessionId },
        'summarizer_error',
      );
      return this.buildFallbackSummary(sessionId, level, originalTokens, messages);
    }
  }

  /**
   * Format messages into a readable text for summarization.
   * Truncates very long messages to avoid hitting token limits in the summary request.
   */
  private formatConversationForSummary(messages: OpenAIMessage[]): string {
    const MAX_MSG_CHARS = 2000;
    const parts: string[] = [];

    for (const msg of messages) {
      const role = msg.role.toUpperCase();
      let content = '';

      if (typeof msg.content === 'string') {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        content = (msg.content as Array<{ text?: string }>)
          .map((p) => p.text ?? '')
          .join('\n');
      }

      if (content.length > MAX_MSG_CHARS) {
        content = content.slice(0, MAX_MSG_CHARS) + `\n...[truncated, ${content.length - MAX_MSG_CHARS} more chars]`;
      }

      if (content.trim()) {
        parts.push(`${role}: ${content}`);
      }
    }

    return parts.join('\n\n---\n\n');
  }

  /**
   * Call the upstream model to generate a summary.
   */
  private async callUpstreamForSummary(conversationText: string): Promise<string | null> {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
            { role: 'user', content: SUMMARY_USER_PROMPT(conversationText) },
          ],
          max_tokens: 2000,
          temperature: 0.3,
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        this.logger.warn(
          { status: response.status },
          'summarizer_upstream_error',
        );
        return null;
      }

      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      return data?.choices?.[0]?.message?.content ?? null;
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      this.logger.warn(
        { err: isAbort ? 'AbortError (timeout)' : String(err) },
        'summarizer_fetch_error',
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Parse the JSON response from the summarization model.
   */
  private parseSummaryResponse(
    rawText: string,
    sessionId: string,
    level: CompactionLevel,
    originalTokens: number,
  ): SessionSummary {
    // Strip markdown code fences if present
    let jsonText = rawText.trim();
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
    }

    try {
      const parsed = JSON.parse(jsonText) as Partial<{
        userGoal: string;
        completedWork: string[];
        modifiedFiles: Array<{ path: string; description: string }>;
        architectureDecisions: string[];
        currentWork: string;
        openIssues: string[];
        pendingTasks: string[];
        nextAction: string;
        notes: string;
      }>;

      return {
        sessionId,
        userGoal: parsed.userGoal ?? 'Not specified',
        completedWork: Array.isArray(parsed.completedWork) ? parsed.completedWork : [],
        modifiedFiles: Array.isArray(parsed.modifiedFiles) ? parsed.modifiedFiles : [],
        architectureDecisions: Array.isArray(parsed.architectureDecisions)
          ? parsed.architectureDecisions
          : [],
        currentWork: parsed.currentWork ?? 'Not specified',
        openIssues: Array.isArray(parsed.openIssues) ? parsed.openIssues : [],
        pendingTasks: Array.isArray(parsed.pendingTasks) ? parsed.pendingTasks : [],
        nextAction: parsed.nextAction ?? 'Continue from where we left off',
        notes: parsed.notes ?? '',
        generatedAt: new Date().toISOString(),
        compactionLevel: level,
        originalTokens,
      };
    } catch {
      this.logger.warn({ rawText: rawText.slice(0, 200) }, 'summarizer_json_parse_error');
      return this.buildTextSummary(rawText, sessionId, level, originalTokens);
    }
  }

  /**
   * Build a summary from raw text when JSON parsing fails.
   */
  private buildTextSummary(
    rawText: string,
    sessionId: string,
    level: CompactionLevel,
    originalTokens: number,
  ): SessionSummary {
    return {
      sessionId,
      userGoal: 'See notes for summary',
      completedWork: [],
      modifiedFiles: [],
      architectureDecisions: [],
      currentWork: 'See notes for current work',
      openIssues: [],
      pendingTasks: [],
      nextAction: 'Review the summary notes and continue from where we left off',
      notes: rawText.slice(0, 3000),
      generatedAt: new Date().toISOString(),
      compactionLevel: level,
      originalTokens,
    };
  }

  /**
   * Build a minimal fallback summary when AI summarization is not available.
   */
  private buildFallbackSummary(
    sessionId: string,
    level: CompactionLevel,
    originalTokens: number,
    messages: OpenAIMessage[],
  ): SessionSummary {
    // Extract key info from messages heuristically
    const userMessages = messages.filter((m) => m.role === 'user');
    const assistantMessages = messages.filter((m) => m.role === 'assistant');

    const firstUserMsg =
      typeof userMessages[0]?.content === 'string'
        ? userMessages[0].content.slice(0, 200)
        : '';

    const lastAssistantMsg =
      typeof assistantMessages[assistantMessages.length - 1]?.content === 'string'
        ? (assistantMessages[assistantMessages.length - 1].content as string).slice(0, 200)
        : '';

    return {
      sessionId,
      userGoal: firstUserMsg || 'Session goal not captured',
      completedWork: [],
      modifiedFiles: [],
      architectureDecisions: [],
      currentWork: lastAssistantMsg || 'Previous work summary not available',
      openIssues: [],
      pendingTasks: [],
      nextAction: 'Continue from the previous context (summary not generated)',
      notes: `Context was compacted at level ${level}. ${messages.length} messages were summarized.`,
      generatedAt: new Date().toISOString(),
      compactionLevel: level,
      originalTokens,
    };
  }

  /**
   * Build the context injection string from a session summary + project state.
   * This gets prepended to the messages array after compaction.
   */
  static buildContextInjection(
    summary: SessionSummary,
    projectState: ProjectState | null,
  ): string {
    const lines: string[] = [
      '## Session Context (Auto-Compacted)',
      '',
      '> This context was automatically generated to preserve your session state.',
      '> Continue working from the "Next Action" below.',
      '',
    ];

    if (summary.userGoal && summary.userGoal !== 'Not specified') {
      lines.push(`### Goal\n${summary.userGoal}\n`);
    }

    if (summary.currentWork && summary.currentWork !== 'Not specified') {
      lines.push(`### Current Work\n${summary.currentWork}\n`);
    }

    if (summary.completedWork.length > 0) {
      lines.push('### Completed Work');
      for (const item of summary.completedWork) {
        lines.push(`- ${item}`);
      }
      lines.push('');
    }

    if (summary.modifiedFiles.length > 0) {
      lines.push('### Modified Files');
      for (const f of summary.modifiedFiles) {
        lines.push(`- \`${f.path}\`: ${f.description}`);
      }
      lines.push('');
    }

    // Merge with project state if available
    const allFiles = projectState?.allModifiedFiles ?? [];
    const extraFiles = allFiles.filter(
      (f) => !summary.modifiedFiles.find((mf) => mf.path === f),
    );
    if (extraFiles.length > 0) {
      lines.push('### Previously Modified Files');
      for (const f of extraFiles) {
        lines.push(`- \`${f}\``);
      }
      lines.push('');
    }

    if (summary.architectureDecisions.length > 0) {
      lines.push('### Architecture Decisions');
      for (const d of summary.architectureDecisions) {
        lines.push(`- ${d}`);
      }
      lines.push('');
    }

    if (summary.openIssues.length > 0) {
      lines.push('### Open Issues');
      for (const issue of summary.openIssues) {
        lines.push(`- ${issue}`);
      }
      lines.push('');
    }

    if (summary.pendingTasks.length > 0) {
      lines.push('### Pending Tasks');
      for (const task of summary.pendingTasks) {
        lines.push(`- ${task}`);
      }
      lines.push('');
    }

    if (summary.notes) {
      lines.push(`### Notes\n${summary.notes}\n`);
    }

    lines.push(`### Next Action\n${summary.nextAction}`);

    return lines.join('\n');
  }
}
