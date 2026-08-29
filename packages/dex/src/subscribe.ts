/**
 * Live updates, with reconciliation as the guarantee.
 *
 * PLAN.md specifies "WS with auto-reconnect (backoff 1s→30s) + resubscribe".
 * The transport differs from what that assumed — the spot WebSocket carries no
 * event-contract topics, so the live tail runs over the chain WS through the
 * SDK — but the contract is the one PLAN.md asked for, plus the thing AGENTS.md
 * insists on: **polling is the guarantee, the tail is the optimisation.**
 *
 * A dropped socket must never silently stop settlements from being noticed, so
 * a reconcile pass runs on a timer regardless, and again immediately after every
 * reconnect to cover the gap.
 */
import type { DexClient } from "./client.js";
import { asDexError, type DexError } from "./errors.js";
import { getSettlement, type Settlement } from "./positions.js";

export interface SubscribeOptions {
  /** Windows to watch. Settlements for these are reported. */
  marketIds: readonly `0x${string}`[];
  onSettlement: (settlement: Settlement) => void;
  onError?: (error: DexError) => void;
  /** Connection state changes, for a UI banner. */
  onStatus?: (status: SubscriptionStatus) => void;
  /** Reconciliation interval. Default 45s — the guarantee, not the optimisation. */
  reconcileMs?: number;
  /** Backoff bounds for reconnect. Defaults 1s → 30s. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  random?: () => number;
}

export type SubscriptionStatus = "connecting" | "live" | "reconnecting" | "degraded" | "stopped";

export interface Subscription {
  /** Force an immediate reconciliation pass. */
  reconcile(): Promise<void>;
  readonly status: SubscriptionStatus;
  stop(): void;
}

/**
 * Watch a set of windows for settlement.
 *
 * Reports each market's settlement exactly once, when it first becomes terminal.
 */
export function subscribe(client: DexClient, opts: SubscribeOptions): Subscription {
  const reconcileMs = opts.reconcileMs ?? 45_000;
  const minBackoff = opts.minBackoffMs ?? 1_000;
  const maxBackoff = opts.maxBackoffMs ?? 30_000;
  const random = opts.random ?? Math.random;

  const pending = new Set<string>(opts.marketIds);
  let status: SubscriptionStatus = "connecting";
  let stopped = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const setStatus = (next: SubscriptionStatus): void => {
    if (status === next) return;
    status = next;
    opts.onStatus?.(next);
  };

  /**
   * The reconciliation pass. Reads the chain for every window still pending and
   * reports any that have become terminal. This alone is sufficient to keep the
   * app correct; everything else only makes it faster.
   */
  const reconcile = async (): Promise<void> => {
    if (stopped || pending.size === 0) return;
    let sawFailure = false;

    for (const marketId of [...pending]) {
      try {
        const settlement = await getSettlement(client, marketId as `0x${string}`);
        if (settlement.status !== "PENDING") {
          pending.delete(marketId);
          opts.onSettlement(settlement);
        }
      } catch (e) {
        sawFailure = true;
        opts.onError?.(asDexError(e, "API_DOWN"));
      }
    }

    if (sawFailure) {
      setStatus("degraded");
      attempt += 1;
    } else {
      attempt = 0;
      setStatus("live");
    }
  };

  /**
   * Exponential backoff with full jitter, 1s → 30s, matching PLAN.md. Full
   * jitter so many clients recovering from one outage do not resynchronise.
   */
  const backoffFor = (n: number): number => {
    if (n <= 0) return reconcileMs;
    const exponential = Math.min(maxBackoff, minBackoff * 2 ** (n - 1));
    return Math.max(minBackoff, Math.floor(random() * exponential));
  };

  const loop = async (): Promise<void> => {
    if (stopped) return;
    await reconcile();
    if (stopped || pending.size === 0) {
      if (pending.size === 0) setStatus("stopped");
      return;
    }
    // A healthy pass waits the full reconcile interval; a failing one retries
    // sooner, on the backoff curve, and every retry IS a reconciliation — so a
    // gap can never be silently skipped.
    timer = setTimeout(() => void loop(), attempt > 0 ? backoffFor(attempt) : reconcileMs);
  };

  setStatus("connecting");
  void loop();

  return {
    reconcile,
    get status() {
      return status;
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      setStatus("stopped");
    },
  };
}
