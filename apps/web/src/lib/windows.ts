import "server-only";

import { getWindows, type DexClient, type Window } from "@predictarena/dex";
import { cached } from "./cache";

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
export function windowsFor(
  dex: DexClient,
  opts: { asset?: string | undefined; intervalSec?: number | undefined } = {},
): Promise<Window[]> {
  const key = `windows:${opts.asset ?? "all"}:${opts.intervalSec ?? "all"}`;
  return cached(key, 2_500, () =>
    getWindows(dex, {
      ...(opts.asset ? { asset: opts.asset } : {}),
      ...(opts.intervalSec !== undefined ? { intervalSec: opts.intervalSec } : {}),
      includeUntradable: true,
      limit: 40,
    }),
  );
}
