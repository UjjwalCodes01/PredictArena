import "server-only";

import {
  getWindows, getWindowsFromCandidates,
  type DexClient, type Window, type WindowCandidate,
} from "@predictarena/dex";
import { getOpenWindows } from "@predictarena/db";
import { cached } from "./cache";
import { serverDb, withDeadline, dbRead } from "./server";

/**
 * The window list, behind ONE cache key per asset.
 *
 * The feed and the terminal both need this. Keying them differently meant a
 * visitor moving between the two pages paid for the same upstream read twice,
 * and a window roll produced a visible stall on whichever page asked first.
 *
 * 2.5s: shorter than any window's meaningful change, long enough that a page
 * load and its immediate refetch collapse into one read. Stale entries are
 * served while refreshing, so only the very first caller ever waits.
 */
/**
 * When the venue indexer last failed.
 *
 * Without this every request pays the full venue timeout before falling back,
 * which measured 44s end to end — past the point a serverless function is
 * killed. After a failure the chain path is used directly for a short while,
 * so an outage costs the timeout ONCE rather than on every page view.
 *
 * Short on purpose: the venue recovering must not be waited out.
 */
let venueFailedAt = 0;
const VENUE_COOLDOWN_MS = 60_000;

export function windowsFor(
  dex: DexClient,
  opts: { asset?: string | undefined; intervalSec?: number | undefined } = {},
): Promise<Window[]> {
  const key = `windows:${opts.asset ?? "all"}:${opts.intervalSec ?? "all"}`;
  return cached(key, 2_500, async () => {
    // Still inside the cooldown from a recent failure: go straight to the
    // chain rather than paying the timeout again.
    if (Date.now() - venueFailedAt < VENUE_COOLDOWN_MS) {
      const quick = await fromChain(dex, opts);
      if (quick.length > 0) return quick;
      // Chain path came back empty — fall through and give the venue a chance.
    }

    try {
      // 10s. Slower than this and the venue is not going to save the request;
      // the chain path still has to run inside the same function lifetime.
      const live = await withDeadline("getWindows", 7_000, () =>
        getWindows(dex, {
          ...(opts.asset ? { asset: opts.asset } : {}),
          ...(opts.intervalSec !== undefined ? { intervalSec: opts.intervalSec } : {}),
          includeUntradable: true,
          limit: 40,
        }),
      );
      venueFailedAt = 0;
      return live;
    } catch (e) {
      venueFailedAt = Date.now();
      const viaChain = await fromChain(dex, opts);
      // Nothing to fall back to: report the original venue failure, which is
      // the one that actually explains the outage.
      if (viaChain.length === 0) throw e;
      console.warn(
        `[windows] venue indexer unavailable; served ${viaChain.length} window(s) ` +
          `read directly from chain. (${e instanceof Error ? e.message : "unknown"})`,
      );
      return viaChain;
    }
  });
}

/**
 * The window list without the venue's indexer.
 *
 * Its `listLiveBinaryMarkets` is the only way to learn which markets exist, so
 * when it hangs the whole product goes dark — measured in production: a bare
 * `Market(limit:1){id}` timing out at 31s while an invalid field errored in
 * 1.6s. Our own projection already knows which markets were open, and the
 * chain still answers in ~1-2s, so between them the core flow survives.
 *
 * Every fact that matters — status, pool, expiry — is still read from the
 * chain. The projection only supplies candidate ids and the descriptive fields
 * the chain does not carry.
 */
/** Chain reads cost ~1-2s each, so this bounds the fallback's wall time. */
const CHAIN_FALLBACK_MAX = 10;

async function fromChain(
  dex: DexClient,
  opts: { asset?: string | undefined; intervalSec?: number | undefined },
): Promise<Window[]> {
  try {
    const rows = await dbRead(() => getOpenWindows(serverDb(), 120));
    const nowMs = Date.now();
    const candidates: WindowCandidate[] = rows
      .filter((r) => r.pool !== null)
      .filter((r) => !opts.asset || r.asset.toUpperCase() === opts.asset.toUpperCase())
      .filter((r) => opts.intervalSec === undefined || r.intervalSec === opts.intervalSec)
      // The projection's close time is a HINT, used only to avoid spending a
      // chain read on a window that has obviously ended. Whether a window is
      // really open is still decided on-chain, below.
      .filter((r) => r.closesAt.getTime() > nowMs)
      .sort((a, b) => a.closesAt.getTime() - b.closesAt.getTime())
      // Each candidate costs a chain read of ~1-2s. Reading sixty of them took
      // 29s, which no request survives; the soonest-closing handful is what a
      // player can actually act on anyway.
      .slice(0, CHAIN_FALLBACK_MAX)
      .map((r) => ({
        marketId: r.id as `0x${string}`,
        asset: r.asset,
        venueId: r.venueId,
        intervalSec: r.intervalSec,
        strike: r.strike,
        opensAtSec: Math.floor(r.opensAt.getTime() / 1000),
      }));

    if (candidates.length === 0) return [];
    return await withDeadline("windowsFromChain", 25_000, () =>
      getWindowsFromCandidates(dex, candidates, { includeUntradable: true }),
    );
  } catch {
    // The fallback failing is not itself reportable — the caller raises the
    // original venue error, which is the useful one.
    return [];
  }
}
