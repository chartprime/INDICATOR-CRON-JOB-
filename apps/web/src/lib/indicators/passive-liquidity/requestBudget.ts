export const COLUMN_HISTORY_MAX_PER_MINUTE = 149;

export const COLUMN_HISTORY_MAX_IN_FLIGHT = 4;

export const RETRY_AFTER_FLOOR_MS = 2_000;

const WINDOW_MS = 60_000;

export function retryDelayMs(retryAfterMs: number | undefined, fallbackMs: number): number {
  if (typeof retryAfterMs !== "number" || !Number.isFinite(retryAfterMs) || retryAfterMs < 0) return fallbackMs;
  return Math.min(fallbackMs, Math.max(RETRY_AFTER_FLOOR_MS, retryAfterMs));
}

function waitFor(times: readonly number[], max: number, at: number): number {
  return times.length >= max ? times[0] + WINDOW_MS - at : 0;
}

export class RequestBudget {
  readonly maxPerMinute: number;
  private _times: number[] = [];

  constructor(maxPerMinute: number) {
    this.maxPerMinute = maxPerMinute;
  }

  share(cap = this.maxPerMinute): RequestShare {
    return new RequestShare(this, cap);
  }

  left(at: number): boolean {
    this._times = this._times.filter((t) => at - t < WINDOW_MS);
    return this._times.length < this.maxPerMinute;
  }

  take(at: number): void {
    this._times.push(at);
  }

  waitMs(at: number): number {
    return waitFor(this._times, this.maxPerMinute, at);
  }
}

export class RequestShare {
  readonly pool: RequestBudget;
  readonly cap: number;
  private _times: number[] = [];

  constructor(pool: RequestBudget, cap: number) {
    this.pool = pool;
    this.cap = cap;
  }

  left(at: number): boolean {
    this._times = this._times.filter((t) => at - t < WINDOW_MS);
    const pooled = this.pool.left(at);
    return this._times.length < this.cap && pooled;
  }

  take(at: number): void {
    this._times.push(at);
    this.pool.take(at);
  }

  waitMs(at: number): number {
    return Math.max(1, waitFor(this._times, this.cap, at), this.pool.waitMs(at));
  }
}

export class InFlightPool {
  readonly max: number;
  private _held = 0;

  constructor(max: number) {
    this.max = max;
  }

  get held(): number {
    return this._held;
  }

  left(): boolean {
    return this._held < this.max;
  }

  take(): void {
    this._held += 1;
  }

  free(count = 1): void {
    this._held = Math.max(0, this._held - count);
  }
}
