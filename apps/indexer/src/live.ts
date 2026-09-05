/**
 * Live tail -- the OPTIMISATION, never the guarantee.
 *
 * A WS subscription runs alongside the 45s reconciler by design. The division
 * of labour matters and is easy to get backwards: the poller is what makes the
 * projection correct, and this only makes it fast. So every failure mode here
 * degrades to "settlements land within 45s instead of within seconds" -- never
 * to "settlements are missed".
 *
 * Concretely that means:
 *  - a tail that never connects is a warning, not a fatal error;
 *  - a dropped socket reconnects with exponential backoff, 1s -> 30s;
 *  - and after ANY reconnect a reconciliation pass runs immediately, because
 *    the gap while we were disconnected is exactly where an event hides.
 */
import type { DexClient } from "@predictarena/dex";
import { log } from "./log";

export interface LiveTailOptions {
  /** Called when the tail suggests something changed. Debounced. */
  onChange: () => void;
  /** Called after every (re)connect, to cover the gap. */
  onReconnect: () => void;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Collapse bursts of store updates into at most one call per window. */
  debounceMs?: number;
  random?: () => number;
}

export interface LiveTail {
  readonly connected: boolean;
  stop(): void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function startLiveTail(dex: DexClient, opts: LiveTailOptions): LiveTail {
  const minBackoff = opts.minBackoffMs ?? 1_000;
  const maxBackoff = opts.maxBackoffMs ?? 30_000;
  const debounceMs = opts.debounceMs ?? 2_000;
  const random = opts.random ?? Math.random;

  let stopped = false;
  let connected = false;
  let attempt = 0;
  let unsubscribe: (() => void) | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Exponential backoff with full jitter, so many clients do not resynchronise. */
  const backoffFor = (n: number): number =>
    Math.max(minBackoff, Math.floor(random() * Math.min(maxBackoff, minBackoff * 2 ** Math.max(0, n - 1))));

  const nudge = (): void => {
    if (stopped || debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (!stopped) opts.onChange();
    }, debounceMs);
  };

  const connect = async (): Promise<void> => {
    while (!stopped) {
      try {
        // `discover: true` follows new windows as the venue rolls them, so a
        // freshly-created market is tailed without us re-subscribing by hand.
        await dex.exchange.client.watchMarkets({ discover: true });
        unsubscribe = dex.exchange.client.subscribeLive(nudge);
        connected = true;
        attempt = 0;
        log.info("live tail connected");

        // The gap while we were down is precisely where a settlement hides.
        opts.onReconnect();

        // Hold the connection, watching for it to drop.
        while (!stopped && dex.exchange.client.isTailing()) {
          await sleep(5_000);
        }
        if (stopped) return;

        connected = false;
        log.warn("live tail dropped");
      } catch (e) {
        connected = false;
        log.warn(
          { err: e instanceof Error ? e.message : String(e) },
          "live tail failed to connect (polling still guarantees correctness)",
        );
      }

      unsubscribe?.();
      unsubscribe = null;
      if (stopped) return;

      attempt += 1;
      const wait = backoffFor(attempt);
      log.info({ attempt, waitMs: wait }, "live tail reconnecting");
      await sleep(wait);
    }
  };

  void connect();

  return {
    get connected() {
      return connected;
    },
    stop() {
      stopped = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      unsubscribe?.();
      try {
        dex.exchange.client.stopLive();
      } catch {
        /* nothing live to stop */
      }
    },
  };
}
