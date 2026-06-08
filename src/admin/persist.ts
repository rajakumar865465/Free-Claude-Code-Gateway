import * as fs from 'node:fs';
import * as path from 'node:path';
import { getLogger } from '../utils/logger';

const DATA_DIR = path.resolve(process.cwd(), '.blueclaude-data');

function ensureDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function filePath(name: string): string {
  return path.join(DATA_DIR, `${name}.json`);
}

export function loadJson<T>(name: string, fallback: T): T {
  try {
    ensureDir();
    const p = filePath(name);
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, 'utf-8').trim();
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as T;
    return parsed;
  } catch {
    return fallback;
  }
}

export function saveJson(name: string, data: unknown): void {
  try {
    ensureDir();
    const p = filePath(name);
    const tmp = `${p}.tmp`;
    const content = JSON.stringify(data, null, 2);
    // Write to temp file first, then atomically rename — prevents corrupt files
    // if the process is killed mid-write
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, p);
  } catch (err) {
    // getLogger() is safe here — by the time saveJson is first called the logger
    // is already initialised (AdminState is created after loadConfig/getLogger in server.ts).
    try {
      getLogger().error({ err, name }, 'persist_save_failed');
    } catch {
      // Absolute last resort if logger itself fails (e.g. during early startup)
      console.error(`[persist] failed to save ${name}:`, err);
    }
  }
}

/** Delete a persisted JSON file. Silently succeeds if the file does not exist. */
export function deleteJson(name: string): void {
  try {
    const p = filePath(name);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    // Also clean up any leftover .tmp file from a previously interrupted write
    const tmp = `${p}.tmp`;
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  } catch (err) {
    try {
      getLogger().warn({ err, name }, 'persist_delete_failed');
    } catch {
      console.error(`[persist] failed to delete ${name}:`, err);
    }
  }
}

/**
 * Truncate the named file to zero bytes.
 * Used to rotate server.log / server-err.log on startup without deleting
 * the file (PM2 / pino hold a file descriptor and need the inode to stay).
 */
export function truncateFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.truncateSync(filePath, 0);
    }
  } catch (err) {
    try {
      getLogger().warn({ err, filePath }, 'log_truncate_failed');
    } catch {
      console.error(`[persist] failed to truncate ${filePath}:`, err);
    }
  }
}
