import { randomUUID } from 'node:crypto';
import { loadJson, saveJson, deleteJson } from './persist';

export interface RequestLogEntry {
  id: string;
  timestamp: string;
  endpoint: string;
  method: string;
  clientModel: string;
  resolvedModel: string;
  status: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  streaming: boolean;
  error?: string;
  cascadedToBackup?: boolean;
  /** Set to 'non_stream' when streaming failed and a non-stream retry succeeded */
  fallback?: 'non_stream';
}

export type RequestLogListener = (entry: RequestLogEntry) => void;

const SAVE_DEBOUNCE_MS = 2000;
const STORAGE_KEY = 'request-log';

export class RequestLog {
  private readonly capacity: number;
  private buffer: RequestLogEntry[] = [];
  private readonly listeners = new Set<RequestLogListener>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(capacity = 1000, clearOnStart = false) {
    this.capacity = capacity;
    if (clearOnStart) {
      // Wipe persisted log immediately so a fresh session starts clean
      deleteJson(STORAGE_KEY);
      this.buffer = [];
    } else {
      this.buffer = loadJson<RequestLogEntry[]>(STORAGE_KEY, []);
      if (this.buffer.length > this.capacity) {
        this.buffer = this.buffer.slice(-this.capacity);
      }
    }
  }

  record(input: Omit<RequestLogEntry, 'id' | 'timestamp'> & { timestamp?: string }): RequestLogEntry {
    const entry: RequestLogEntry = {
      id: randomUUID(),
      timestamp: input.timestamp ?? new Date().toISOString(),
      endpoint: input.endpoint,
      method: input.method,
      clientModel: input.clientModel,
      resolvedModel: input.resolvedModel,
      status: input.status,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      latencyMs: input.latencyMs,
      streaming: input.streaming,
      error: input.error,
      cascadedToBackup: input.cascadedToBackup,
      fallback: input.fallback,
    };
    this.buffer.push(entry);
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity);
    }
    this.scheduleSave();
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        /* ignore listener errors */
      }
    }
    return entry;
  }

  list(): RequestLogEntry[] {
    return [...this.buffer];
  }

  latestFirst(): RequestLogEntry[] {
    return [...this.buffer].reverse();
  }

  clear(): void {
    this.buffer.length = 0;
    saveJson(STORAGE_KEY, []);
  }

  size(): number {
    return this.buffer.length;
  }

  subscribe(listener: RequestLogListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      saveJson(STORAGE_KEY, this.buffer);
    }, SAVE_DEBOUNCE_MS);
  }
}
