import type { RequestLog, RequestLogEntry } from './request-log';

export interface PerModelStats {
  model: string;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  errorCount: number;
  avgLatencyMs: number;
}

export interface OverallStats {
  totalRequests: number;
  successCount: number;
  errorCount: number;
  errorRate: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  medianLatencyMs: number;
  p95LatencyMs: number;
  requestsPerMinute: number;
  costEstimate: number;
}

export interface StatsPayload {
  overall: OverallStats;
  perModel: PerModelStats[];
  inputPricePerMillion: number;
  outputPricePerMillion: number;
}

export class StatsEngine {
  private inputPricePerMillion = 0;
  private outputPricePerMillion = 0;

  constructor(private readonly log: RequestLog) {}

  setPrices(inputPricePerMillion: number, outputPricePerMillion: number): void {
    this.inputPricePerMillion = inputPricePerMillion;
    this.outputPricePerMillion = outputPricePerMillion;
  }

  getPrices(): { input: number; output: number } {
    return { input: this.inputPricePerMillion, output: this.outputPricePerMillion };
  }

  compute(): StatsPayload {
    const entries = this.log.list();
    const latencies = entries.map((e) => e.latencyMs).filter((n) => Number.isFinite(n) && n >= 0);
    latencies.sort((a, b) => a - b);

    const total = entries.length;
    const success = entries.filter((e) => e.status >= 200 && e.status < 300).length;
    const errors = entries.filter((e) => e.status >= 400).length;
    const totalIn = entries.reduce((s, e) => s + (e.inputTokens || 0), 0);
    const totalOut = entries.reduce((s, e) => s + (e.outputTokens || 0), 0);
    const costEstimate =
      (totalIn / 1_000_000) * this.inputPricePerMillion +
      (totalOut / 1_000_000) * this.outputPricePerMillion;

    const overall: OverallStats = {
      totalRequests: total,
      successCount: success,
      errorCount: errors,
      errorRate: total === 0 ? 0 : (errors / total) * 100,
      totalInputTokens: totalIn,
      totalOutputTokens: totalOut,
      totalTokens: totalIn + totalOut,
      medianLatencyMs: total === 0 ? 0 : percentile(latencies, 50),
      p95LatencyMs: total === 0 ? 0 : percentile(latencies, 95),
      requestsPerMinute: requestsInLastMinute(entries),
      costEstimate: round2(costEstimate),
    };

    const perModel = computePerModel(entries);

    return {
      overall,
      perModel,
      inputPricePerMillion: this.inputPricePerMillion,
      outputPricePerMillion: this.outputPricePerMillion,
    };
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[idx]);
}

function requestsInLastMinute(entries: RequestLogEntry[]): number {
  // Entries are appended in chronological order, so scan from the end
  // and stop as soon as we've passed the 60-second window — O(k) not O(n).
  const cutoff = Date.now() - 60_000;
  let n = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (new Date(entries[i].timestamp).getTime() >= cutoff) {
      n++;
    } else {
      break; // entries before this point are all older than 60s
    }
  }
  return n;
}

function computePerModel(entries: RequestLogEntry[]): PerModelStats[] {
  const byModel = new Map<string, { count: number; inTok: number; outTok: number; err: number; lat: number }>();
  for (const e of entries) {
    const key = e.resolvedModel || '(unknown)';
    const cur = byModel.get(key) ?? { count: 0, inTok: 0, outTok: 0, err: 0, lat: 0 };
    cur.count += 1;
    cur.inTok += e.inputTokens || 0;
    cur.outTok += e.outputTokens || 0;
    if (e.status >= 400) cur.err += 1;
    cur.lat += e.latencyMs || 0;
    byModel.set(key, cur);
  }
  const result: PerModelStats[] = [];
  for (const [model, v] of byModel) {
    result.push({
      model,
      requestCount: v.count,
      inputTokens: v.inTok,
      outputTokens: v.outTok,
      errorCount: v.err,
      avgLatencyMs: v.count === 0 ? 0 : Math.round(v.lat / v.count),
    });
  }
  result.sort((a, b) => b.requestCount - a.requestCount);
  return result;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
