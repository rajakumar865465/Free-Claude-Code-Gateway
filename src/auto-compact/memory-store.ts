/**
 * Memory Store — Persists session summaries, project state, and compaction history.
 *
 * Files written to `.blueclaude-data/memory/`:
 *   session-summary.json     — latest summary per session
 *   project-state.json       — aggregated project state per session
 *   compaction-history.json  — log of all compaction events
 *   context-windows.json     — active context window snapshots
 *   auto-compact-settings.json — user-configurable settings
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getLogger } from '../utils/logger';
import type {
  SessionSummary,
  ProjectState,
  CompactionHistory,
  CompactionHistoryEntry,
  AutoCompactSettings,
  ContextWindow,
} from './types';
import { DEFAULT_AUTO_COMPACT_SETTINGS } from './types';

const DATA_DIR = path.resolve(process.cwd(), '.blueclaude-data', 'memory');

// ─── Low-level file utilities ─────────────────────────────────────────────────

function ensureDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function filePath(name: string): string {
  return path.join(DATA_DIR, `${name}.json`);
}

function readJson<T>(name: string, fallback: T): T {
  try {
    ensureDir();
    const p = filePath(name);
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, 'utf-8').trim();
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(name: string, data: unknown): void {
  try {
    ensureDir();
    const p = filePath(name);
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, p);
  } catch (err) {
    try {
      getLogger().error({ err, name }, 'memory_store_write_failed');
    } catch {
      console.error(`[memory-store] failed to write ${name}:`, err);
    }
  }
}

// ─── MemoryStore class ────────────────────────────────────────────────────────

export class MemoryStore {
  private settings: AutoCompactSettings;
  private summaries: Record<string, SessionSummary> = {};
  private projectStates: Record<string, ProjectState> = {};
  private history: CompactionHistory;
  private contextWindows: Record<string, ContextWindow> = {};
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.settings = readJson<AutoCompactSettings>(
      'auto-compact-settings',
      DEFAULT_AUTO_COMPACT_SETTINGS,
    );
    // Merge with defaults to pick up any new fields added to DEFAULT
    this.settings = { ...DEFAULT_AUTO_COMPACT_SETTINGS, ...this.settings };

    this.summaries = readJson<Record<string, SessionSummary>>('session-summary', {});
    this.projectStates = readJson<Record<string, ProjectState>>('project-state', {});
    this.history = readJson<CompactionHistory>('compaction-history', {
      entries: [],
      totalCompactions: 0,
      totalTokensSaved: 0,
      lastCompactionAt: null,
    });
    this.contextWindows = readJson<Record<string, ContextWindow>>('context-windows', {});
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  getSettings(): AutoCompactSettings {
    return { ...this.settings };
  }

  updateSettings(patch: Partial<AutoCompactSettings>): AutoCompactSettings {
    this.settings = { ...this.settings, ...patch };
    writeJson('auto-compact-settings', this.settings);
    return { ...this.settings };
  }

  // ── Session Summaries ─────────────────────────────────────────────────────

  saveSummary(summary: SessionSummary): void {
    this.summaries[summary.sessionId] = summary;
    this.scheduleSave('session-summary', this.summaries);
  }

  getSummary(sessionId: string): SessionSummary | null {
    return this.summaries[sessionId] ?? null;
  }

  getAllSummaries(): Record<string, SessionSummary> {
    return { ...this.summaries };
  }

  deleteSummary(sessionId: string): void {
    delete this.summaries[sessionId];
    writeJson('session-summary', this.summaries);
  }

  // ── Project State ─────────────────────────────────────────────────────────

  saveProjectState(state: ProjectState): void {
    this.projectStates[state.sessionId] = state;
    this.scheduleSave('project-state', this.projectStates);
  }

  getProjectState(sessionId: string): ProjectState | null {
    return this.projectStates[sessionId] ?? null;
  }

  updateProjectState(sessionId: string, patch: Partial<ProjectState>): ProjectState {
    const existing = this.projectStates[sessionId] ?? {
      sessionId,
      projectRoot: '',
      allModifiedFiles: [],
      architectureDecisions: [],
      todoItems: [],
      systemPrompts: [],
      sessionStartedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
    };
    const updated: ProjectState = {
      ...existing,
      ...patch,
      lastUpdatedAt: new Date().toISOString(),
      // Arrays are merged (deduped), not replaced
      allModifiedFiles: Array.from(
        new Set([
          ...existing.allModifiedFiles,
          ...(patch.allModifiedFiles ?? []),
        ]),
      ),
      architectureDecisions: Array.from(
        new Set([
          ...existing.architectureDecisions,
          ...(patch.architectureDecisions ?? []),
        ]),
      ),
      todoItems: Array.from(
        new Set([
          ...existing.todoItems,
          ...(patch.todoItems ?? []),
        ]),
      ),
      systemPrompts: Array.from(
        new Set([
          ...existing.systemPrompts,
          ...(patch.systemPrompts ?? []),
        ]),
      ),
    };
    this.projectStates[sessionId] = updated;
    this.scheduleSave('project-state', this.projectStates);
    return updated;
  }

  // ── Compaction History ────────────────────────────────────────────────────

  recordCompaction(entry: CompactionHistoryEntry): void {
    this.history.entries.push(entry);
    this.history.totalCompactions++;
    this.history.totalTokensSaved += entry.tokensSaved;
    this.history.lastCompactionAt = entry.compactedAt;

    // Trim to max
    const max = this.settings.maxHistoryEntries;
    if (this.history.entries.length > max) {
      this.history.entries = this.history.entries.slice(-max);
    }

    writeJson('compaction-history', this.history);
  }

  getHistory(): CompactionHistory {
    return { ...this.history, entries: [...this.history.entries] };
  }

  getHistoryForSession(sessionId: string): CompactionHistoryEntry[] {
    return this.history.entries.filter((e) => e.sessionId === sessionId);
  }

  // ── Context Windows ───────────────────────────────────────────────────────

  saveContextWindow(window: ContextWindow): void {
    this.contextWindows[window.sessionId] = window;
    this.scheduleSave('context-windows', this.contextWindows);
  }

  getContextWindow(sessionId: string): ContextWindow | null {
    return this.contextWindows[sessionId] ?? null;
  }

  getAllContextWindows(): Record<string, ContextWindow> {
    return { ...this.contextWindows };
  }

  deleteContextWindow(sessionId: string): void {
    delete this.contextWindows[sessionId];
    writeJson('context-windows', this.contextWindows);
  }

  clearAllContextWindows(): void {
    this.contextWindows = {};
    writeJson('context-windows', this.contextWindows);
  }

  // ── Computed Stats ────────────────────────────────────────────────────────

  getTotalTokensSaved(): number {
    return this.history.totalTokensSaved;
  }

  getTotalCompactions(): number {
    return this.history.totalCompactions;
  }

  // ── Debounced save ────────────────────────────────────────────────────────

  private scheduleSave(name: string, data: unknown): void {
    // Write immediately for compaction-critical data;
    // debounce for higher-frequency context window updates
    if (name === 'session-summary' || name === 'project-state') {
      writeJson(name, data);
      return;
    }
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      writeJson(name, data);
    }, 1000);
  }
}
