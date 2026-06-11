/**
 * Per-model sliding-window circuit breaker.
 *
 * State machine:
 *   CLOSED  → normal traffic
 *   OPEN    → all requests short-circuit immediately (after N consecutive failures)
 *   HALF    → one probe request is allowed through to test recovery
 *
 * All state is in-process (resets on restart).  That's intentional — the
 * failures we care about are transient upstream stalls, not permanent outages.
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF';

interface ModelCircuit {
  state: CircuitState;
  failureTimes: number[];   // timestamps of recent failures (rolling window)
  openedAt: number | null;  // when the circuit was opened
}

export interface CircuitBreakerOptions {
  /** Consecutive failures inside the rolling window to open the circuit */
  failureThreshold: number;
  /** ms the circuit stays OPEN before transitioning to HALF for a probe */
  recoveryMs: number;
  /** Rolling window in which failures are counted */
  rollingMs: number;
}

export class CircuitBreaker {
  private readonly circuits = new Map<string, ModelCircuit>();
  private readonly opts: CircuitBreakerOptions;

  constructor(opts: CircuitBreakerOptions) {
    this.opts = opts;
  }

  /** Returns current state for a model key */
  getState(model: string): CircuitState {
    return this.getOrCreate(model).state;
  }

  /**
   * Call before making an upstream request.
   * Returns false if the circuit is OPEN (request should be short-circuited).
   * Returns true if the request may proceed (CLOSED or HALF probe).
   */
  allowRequest(model: string): boolean {
    const c = this.getOrCreate(model);
    const now = Date.now();

    if (c.state === 'CLOSED') return true;

    if (c.state === 'OPEN') {
      if (c.openedAt !== null && now - c.openedAt >= this.opts.recoveryMs) {
        // Transition to HALF — allow exactly one probe
        c.state = 'HALF';
        return true;
      }
      return false; // still open
    }

    // HALF — already allowing one probe (subsequent calls block until result recorded)
    return true;
  }

  /** Call after a successful upstream response */
  recordSuccess(model: string): void {
    const c = this.getOrCreate(model);
    c.state = 'CLOSED';
    c.failureTimes = [];
    c.openedAt = null;
  }

  /**
   * Call after a 504 / idle-abort failure.
   * Returns the new state.
   */
  recordFailure(model: string): CircuitState {
    const c = this.getOrCreate(model);
    const now = Date.now();

    // Prune failures outside the rolling window
    c.failureTimes = c.failureTimes.filter((t) => now - t < this.opts.rollingMs);
    c.failureTimes.push(now);

    if (c.state === 'HALF' || c.failureTimes.length >= this.opts.failureThreshold) {
      c.state = 'OPEN';
      c.openedAt = now;
    }

    return c.state;
  }

  /** Returns a snapshot suitable for logging */
  snapshot(model: string): { state: CircuitState; recentFailures: number; openedAt: number | null } {
    const c = this.getOrCreate(model);
    const now = Date.now();
    return {
      state: c.state,
      recentFailures: c.failureTimes.filter((t) => now - t < this.opts.rollingMs).length,
      openedAt: c.openedAt,
    };
  }

  private getOrCreate(model: string): ModelCircuit {
    let c = this.circuits.get(model);
    if (!c) {
      c = { state: 'CLOSED', failureTimes: [], openedAt: null };
      this.circuits.set(model, c);
    }
    return c;
  }
}
