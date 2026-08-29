/**
 * Serialised request queue with jittered retry.
 *
 * The Event Contract docs say there are no API rate limits ("market data is the
 * chain itself"), but that is a statement about the venue, not about whatever
 * RPC or indexer we happen to point at — and the indexer's Portfolio query was
 * observed failing transiently during Phase 0. So every outbound call goes
 * through here: bounded concurrency, and retry with full jitter on the errors
 * that are actually worth retrying.
 *
 * Full jitter (`random(0, backoff)`) rather than fixed backoff, so a fleet of
 * clients recovering from the same blip does not resynchronise into a thundering
 * herd.
 */
import { DexError, asDexError } from "./errors.js";

export interface QueueOptions {
  /** Simultaneous in-flight calls. 1 serialises completely. */
  concurrency?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injectable for tests; defaults to Math.random. */
  random?: () => number;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class RequestQueue {
  private readonly concurrency: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private active = 0;
  private readonly pending: Array<() => void> = [];

  constructor(opts: QueueOptions = {}) {
    this.concurrency = Math.max(1, opts.concurrency ?? 4);
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
    this.baseDelayMs = opts.baseDelayMs ?? 250;
    this.maxDelayMs = opts.maxDelayMs ?? 8_000;
    this.random = opts.random ?? Math.random;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** Delay for attempt N (1-based), exponential with full jitter. */
  backoffFor(attempt: number): number {
    const exponential = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempt - 1));
    return Math.floor(this.random() * exponential);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await this.withRetry(fn);
    } finally {
      this.release();
    }
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: DexError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await fn();
      } catch (e) {
        const err = asDexError(e);
        lastError = err;
        // Only retry what could plausibly succeed unchanged. Retrying a
        // WINDOW_CLOSED or an INSUFFICIENT_STAKE just wastes the user's time.
        if (!err.retryable || attempt === this.maxAttempts) throw err;
        await this.sleep(this.backoffFor(attempt));
      }
    }
    /* c8 ignore next */
    throw lastError ?? new DexError("UNKNOWN", "Retry loop exited without a result.");
  }

  private async acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.pending.push(resolve));
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    this.pending.shift()?.();
  }
}
