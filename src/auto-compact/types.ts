/**
 * Auto-Compact Context System — Type Definitions
 *
 * Models all the data structures used by the context tracking,
 * compaction, summarization, and memory storage subsystems.
 */

// ─── Context Tracking ────────────────────────────────────────────────────────

export interface ContextWindow {
  /** Unique session identifier derived from model + first-message hash */
  sessionId: string;
  /** Upstream provider model key (e.g. "kimi-k2.6") */
  model: string;
  /** Maximum context window size in tokens for this model */
  maxTokens: number;
  /** Estimated tokens currently used by the full message array */
  usedTokens: number;
  /** Usage as a fraction 0–1 */
  usageRatio: number;
  /** Threshold (0–1) above which compaction is triggered */
  compactThreshold: number;
  /** Number of messages in the current conversation */
  messageCount: number;
  /** When this window was first created */
  createdAt: string;
  /** When this window was last updated */
  updatedAt: string;
  /** How many compactions have run on this session */
  compactionCount: number;
  /** Total tokens saved across all compactions in this session */
  tokensSaved: number;
}

export interface ContextStats {
  /** Total number of active tracked sessions */
  activeSessions: number;
  /** Total compactions ever performed */
  totalCompactions: number;
  /** Total tokens saved across all sessions */
  totalTokensSaved: number;
  /** Sessions currently above the warn threshold (70%) */
  sessionsNearLimit: number;
  /** Sessions currently above the compact threshold (80%) */
  sessionsOverThreshold: number;
  /** Last compaction timestamp */
  lastCompactionAt: string | null;
}

// ─── Compaction ───────────────────────────────────────────────────────────────

export type CompactionLevel = 1 | 2 | 3;

export interface CompactionResult {
  sessionId: string;
  level: CompactionLevel;
  tokensBeforeCompaction: number;
  tokensAfterCompaction: number;
  tokensSaved: number;
  messagesBeforeCompaction: number;
  messagesAfterCompaction: number;
  summaryGenerated: boolean;
  compactedAt: string;
  durationMs: number;
  error?: string;
}

export interface CompactionRequest {
  /** Session ID to compact — if omitted, pick the highest-usage session */
  sessionId?: string;
  /** Force a specific compaction level (default: auto-select) */
  level?: CompactionLevel;
  /** Whether to generate an AI summary (default: true) */
  generateSummary?: boolean;
}

// ─── Session Memory ───────────────────────────────────────────────────────────

export interface SessionSummary {
  sessionId: string;
  /** The user's stated or inferred goal for this session */
  userGoal: string;
  /** List of completed tasks/actions */
  completedWork: string[];
  /** Files that have been modified (path + reason) */
  modifiedFiles: Array<{ path: string; description: string }>;
  /** Key architecture/design decisions made */
  architectureDecisions: string[];
  /** What the AI was doing immediately before compaction */
  currentWork: string;
  /** Unresolved issues or blockers */
  openIssues: string[];
  /** Remaining tasks to complete */
  pendingTasks: string[];
  /** The exact next action to continue after resumption */
  nextAction: string;
  /** Raw freeform notes */
  notes: string;
  /** When this summary was generated */
  generatedAt: string;
  /** Which compaction level produced this summary */
  compactionLevel: CompactionLevel;
  /** Token count of original messages that were summarized */
  originalTokens: number;
}

export interface ProjectState {
  sessionId: string;
  /** Current working directory or project root inferred from file paths */
  projectRoot: string;
  /** Aggregate list of all files touched across all compactions */
  allModifiedFiles: string[];
  /** Running list of all architecture decisions */
  architectureDecisions: string[];
  /** Running TODO list (never removed, only appended) */
  todoItems: string[];
  /** All system prompts seen — never removed */
  systemPrompts: string[];
  /** First request timestamp for this session */
  sessionStartedAt: string;
  /** Most recent update */
  lastUpdatedAt: string;
}

// ─── Compaction History ────────────────────────────────────────────────────────

export interface CompactionHistoryEntry {
  id: string;
  sessionId: string;
  level: CompactionLevel;
  tokensBeforeCompaction: number;
  tokensAfterCompaction: number;
  tokensSaved: number;
  messagesBeforeCompaction: number;
  messagesAfterCompaction: number;
  compactedAt: string;
  durationMs: number;
  error?: string;
}

export interface CompactionHistory {
  entries: CompactionHistoryEntry[];
  totalCompactions: number;
  totalTokensSaved: number;
  lastCompactionAt: string | null;
}

// ─── Message types used internally ───────────────────────────────────────────

export interface TrackedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Estimated token count for this message */
  estimatedTokens: number;
  /** Whether this message is a tool/function output (candidate for L1 removal) */
  isToolOutput: boolean;
  /** Whether this message is a large file-read result */
  isFileRead: boolean;
  /** Original index in the conversation array */
  originalIndex: number;
}

// ─── Auto-Compact Settings ────────────────────────────────────────────────────

export interface AutoCompactSettings {
  /** Whether auto-compaction is enabled globally */
  enabled: boolean;
  /** Usage ratio threshold (0–1) to trigger compaction. Default: 0.80 */
  compactThreshold: number;
  /** Usage ratio threshold (0–1) to emit a warning. Default: 0.70 */
  warnThreshold: number;
  /** Number of most-recent messages to always keep. Default: 20 */
  keepRecentMessages: number;
  /** Whether to generate AI summaries during compaction. Default: true */
  generateSummary: boolean;
  /** Maximum number of compaction history entries to retain. Default: 100 */
  maxHistoryEntries: number;
  /** Model context window sizes (tokens) keyed by model name pattern */
  modelContextSizes: Record<string, number>;
  /** Default context window size if model not found. Default: 200000 */
  defaultContextSize: number;
}

export const DEFAULT_AUTO_COMPACT_SETTINGS: AutoCompactSettings = {
  enabled: true,
  compactThreshold: 0.80,
  warnThreshold: 0.70,
  keepRecentMessages: 20,
  generateSummary: true,
  maxHistoryEntries: 100,
  modelContextSizes: {
    // Claude models
    'claude-opus-4': 200000,
    'claude-3-5-sonnet': 200000,
    'claude-3-7-sonnet': 200000,
    'claude-sonnet-4': 200000,
    'claude-haiku-4': 200000,
    'claude-3-haiku': 200000,
    // Common OpenAI-compat models
    'gpt-4o': 128000,
    'gpt-4': 128000,
    'gpt-3.5': 16385,
    'kimi': 200000,
    'glm': 128000,
    'deepseek': 64000,
    'gemini': 1000000,
    'llama': 128000,
  },
  defaultContextSize: 200000,
};

// ─── Admin API payload shapes ─────────────────────────────────────────────────

export interface ContextStatusPayload {
  usedTokens: number;
  maxTokens: number;
  usagePercent: number;
  compactions: number;
  tokensSaved: number;
  activeSessions: number;
  sessionsNearLimit: number;
  enabled: boolean;
  threshold: number;
  keepRecentMessages: number;
  lastCompactionAt: string | null;
  topSessions: Array<{
    sessionId: string;
    model: string;
    usedTokens: number;
    maxTokens: number;
    usagePercent: number;
    messageCount: number;
    compactionCount: number;
  }>;
}
