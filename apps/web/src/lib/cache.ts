import "server-only";

/**
 * A tiny in-process cache with stale-while-revalidate.
 *
 * Upstream reads here are round-trip bound: a window list costs ~1.7s and a
 * batch of on-chain statuses ~1.3s no matter how little changed. Three people
 * loading a page in the same second should not each pay for that.
 *
 * Two behaviours matter more than the caching itself:
 *
 *  - **In-flight collapsing.** A burst of misses on a cold key triggers ONE
 *    upstream call, not one per request. A cold cache is exactly the moment the
 *    upstream is least able to absorb a stampede.
 *
 *  - **Stale-while-revalidate.** Once a value exists, an expired entry is
 *    served immediately and refreshed behind the request. Only the very first
 *    visitor ever waits; everyone after sees data that is at worst a few
 *    seconds old, which for a leaderboard is indistinguishable from live.
 *
 * Anything that spends money does NOT come through here. `/api/quote` reads the
 * chain directly every time, because a stale window would send someone to sign
 * into a market that has already locked.
 *
 * In-process by design: it collapses bursts, it is not a durable store, and it
 * does not need to survive a cold start.
 */
type Entry<T = unknown> = {
  value: T | undefined;
  /** When the value stops being fresh. Past this we serve it AND refresh. */
  expiresAt: number;
  /** Beyond this the value is too old to serve at all. */
  hardExpiresAt: number;
  inflight?: Promise<T>;
};

const store = new Map<string, Entry>();

/** How far past its TTL a value may still be served while refreshing. */
const STALE_GRACE_MS = 60_000;

export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key) as Entry<T> | undefined;

  // Fresh.
  if (hit && hit.value !== undefined && hit.expiresAt > now) return hit.value;

  const refresh = (): Promise<T> => {
    const p = fn()
      .then((value) => {
        store.set(key, {
          value,
          expiresAt: Date.now() + ttlMs,
          hardExpiresAt: Date.now() + ttlMs + STALE_GRACE_MS,
        });
        return value;
      })
      .catch((e: unknown) => {
        const current = store.get(key) as Entry<T> | undefined;
        if (current?.value !== undefined) {
          // Keep serving what we have: slightly old data beats an error page,
          // and the next request will try again.
          store.set(key, { ...current, inflight: undefined, expiresAt: Date.now() + 1_000 });
          return current.value;
        }
        store.delete(key);
        throw e;
      });

    store.set(key, {
      value: hit?.value,
      expiresAt: hit?.expiresAt ?? 0,
      hardExpiresAt: hit?.hardExpiresAt ?? 0,
      inflight: p,
    } as Entry);
    return p;
  };

  // Stale but usable: answer now, refresh behind the request.
  if (hit && hit.value !== undefined && hit.hardExpiresAt > now) {
    if (!hit.inflight) void refresh().catch(() => {});
    return hit.value;
  }

  // Cold, or too stale to serve. Join an in-flight fetch rather than starting
  // a second one.
  if (hit?.inflight) return hit.inflight;
  return refresh();
}

/** Drop everything. Used by tests. */
export function clearCache(): void {
  store.clear();
}
