export class AbortControllerWithTimeout {
  readonly controller = new AbortController();
  private timer: NodeJS.Timeout | null = null;

  constructor(ms: number) {
    if (ms > 0) {
      this.timer = setTimeout(() => {
        try {
          this.controller.abort();
        } catch {
          /* noop */
        }
      }, ms);
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
