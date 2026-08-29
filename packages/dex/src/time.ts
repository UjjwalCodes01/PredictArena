/**
 * Server-corrected clock.
 *
 * AGENTS.md forbids trusting the browser clock for cutoffs: a user whose laptop
 * is two minutes fast would see a window as closed while it is still trading,
 * or worse, still open after it locked. Countdowns and all cutoff comparisons
 * run off the chain's own timestamp plus local elapsed time.
 */

export interface ClockSource {
  /** Chain time in seconds. */
  fetchChainTimeSec(): Promise<number>;
  /** Monotonic-ish local milliseconds; injectable for tests. */
  nowMs(): number;
}

export class ServerClock {
  private offsetMs = 0;
  private syncedAtMs: number | null = null;
  private readonly source: ClockSource;
  private readonly resyncAfterMs: number;

  constructor(source: ClockSource, resyncAfterMs = 60_000) {
    this.source = source;
    this.resyncAfterMs = resyncAfterMs;
  }

  /** Measured difference between chain time and this machine's clock. */
  get offsetSeconds(): number {
    return Math.round(this.offsetMs / 1000);
  }

  get isSynced(): boolean {
    return this.syncedAtMs !== null;
  }

  async sync(): Promise<void> {
    const before = this.source.nowMs();
    const chainSec = await this.source.fetchChainTimeSec();
    const after = this.source.nowMs();
    // Assume symmetric latency: the read happened at the midpoint of the round
    // trip, so half the elapsed time is already "spent" chain-side.
    const localMidpointMs = before + (after - before) / 2;
    this.offsetMs = chainSec * 1000 - localMidpointMs;
    this.syncedAtMs = after;
  }

  /** Chain-corrected wall clock in ms. Falls back to local time if never synced. */
  nowMs(): number {
    return this.source.nowMs() + this.offsetMs;
  }

  nowSec(): number {
    return Math.floor(this.nowMs() / 1000);
  }

  /** Seconds until a unix timestamp, corrected. Negative once past. */
  secondsUntil(unixSec: number | string | bigint): number {
    return Number(unixSec) - this.nowMs() / 1000;
  }

  /** True when the last sync is older than the resync interval. */
  get isStale(): boolean {
    return this.syncedAtMs === null || this.source.nowMs() - this.syncedAtMs > this.resyncAfterMs;
  }

  /** Re-syncs only when stale, so callers can call this freely. */
  async ensureFresh(): Promise<void> {
    if (this.isStale) await this.sync();
  }
}
