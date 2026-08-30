/**
 * Up/Down windows.
 *
 * Two rules drive everything here, both learned the hard way in Phase 0:
 *
 *  1. **Gate on the on-chain status, not the indexer.** The indexer lags the
 *     chain by seconds and will happily offer a window that has already locked.
 *     Only status 1 (Trading) accepts orders.
 *  2. **Never trust the local clock.** Countdowns and cutoffs use the
 *     chain-corrected `ServerClock`.
 */
import type { BinaryMarket } from "@somnia-chain/markets-sdk";
import type { DexClient } from "./client.js";
import { asDexError } from "./errors.js";

/** On-chain market status. Numeric values are the contract's, not ours. */
export const MarketStatus = {
  Listed: 0,
  Trading: 1,
  Locked: 2,
  Resolved: 4,
  Voided: 5,
} as const;

export type Direction = "UP" | "DOWN";

/** Outcome index on the market: 0 = Up, 1 = Down. */
export const outcomeIndexFor = (direction: Direction): 0 | 1 => (direction === "UP" ? 0 : 1);
export const directionFor = (outcomeIdx: number): Direction => (outcomeIdx === 0 ? "UP" : "DOWN");

export interface Window {
  readonly marketId: `0x${string}`;
  readonly asset: string;
  readonly pool: `0x${string}`;
  readonly venueId: string | null;
  readonly question: string;
  /** Reference price the outcome is measured against. 0 until the window opens. */
  readonly strike: string;
  readonly intervalSec: number | null;
  readonly opensAtSec: number;
  readonly closesAtSec: number;
  /** Chain-corrected seconds remaining. Negative once past close. */
  readonly secondsLeft: number;
  readonly status: number;
  readonly isTradable: boolean;
  readonly onchain: import("@somnia-chain/markets-sdk").MarketOnchain;
  readonly raw: BinaryMarket;
}

/** Page size for window listing. Pagination continues until a short page. */
const WINDOW_PAGE = 50;

/**
 * Minimum life an order needs, scaled to the series.
 *
 * A flat threshold breaks both ways: 300s of headroom rejects every window on a
 * 60s venue, while too little lets a window lock between snapshot and send.
 * 15% of the interval, clamped to 5–60s.
 */
export function headroomSecFor(intervalSec: number): number {
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) return 15;
  return Math.max(5, Math.min(60, Math.ceil(intervalSec * 0.15)));
}

export interface GetWindowsOptions {
  asset?: string;
  intervalSec?: number;
  venueId?: string;
  /** Include windows that are live but not currently tradable. Default false. */
  includeUntradable?: boolean;
  limit?: number;
}

/**
 * Current and upcoming windows, newest-closing first.
 *
 * Every returned window has had its on-chain status read, so `isTradable` is a
 * chain fact rather than an indexer guess.
 */
export async function getWindows(client: DexClient, opts: GetWindowsOptions = {}): Promise<Window[]> {
  await client.clock.ensureFresh();

  // Follow pagination rather than assuming one page (AGENTS.md). `limit` is the
  // caller's total budget; pages are fetched until it is met or the venue runs
  // out. Six venues run their own series, so a single page can silently hide a
  // whole asset's windows.
  const budget = opts.limit ?? 50;
  const rows: BinaryMarket[] = [];
  try {
    for (let offset = 0; rows.length < budget; offset += WINDOW_PAGE) {
      const page = await client.queue.run(() =>
        client.exchange.client.listLiveBinaryMarkets({
          ...(opts.asset ? { asset: opts.asset.toUpperCase() } : {}),
          ...(opts.intervalSec !== undefined ? { intervalSec: opts.intervalSec } : {}),
          ...(opts.venueId ? { venueId: opts.venueId } : {}),
          orderBy: "closingSoon",
          limit: Math.min(WINDOW_PAGE, budget - rows.length),
          offset,
        }),
      );
      rows.push(...page);
      if (page.length < WINDOW_PAGE) break;
    }
  } catch (e) {
    throw asDexError(e, "API_DOWN");
  }

  // Read on-chain status for every row CONCURRENTLY. Doing this in a sequential
  // loop cost ~1.5s per window -- 10s for seven -- which is far too slow for a
  // page load, let alone an indexer cycle. The request queue still bounds how
  // many are actually in flight.
  const settled = await Promise.all(
    rows.map(async (raw) => {
      try {
        const onchain = await client.queue.run(() => client.exchange.client.getMarketOnchain(raw.marketId));
        return { raw, onchain };
      } catch {
        // A window we cannot read on-chain is a window we must not trade.
        return null;
      }
    }),
  );

  const windows: Window[] = [];
  for (const entry of settled) {
    if (!entry) continue;
    const { raw, onchain } = entry;

    const closesAtSec = Number(raw.expiry);
    const secondsLeft = client.clock.secondsUntil(closesAtSec);
    const intervalSec = raw.intervalSec != null ? Number(raw.intervalSec) : null;
    const isTradable =
      onchain.status === MarketStatus.Trading &&
      secondsLeft >= headroomSecFor(intervalSec ?? 0);

    if (!isTradable && !opts.includeUntradable) continue;

    windows.push({
      marketId: raw.marketId,
      asset: raw.asset,
      pool: onchain.pool,
      venueId: raw.venueId ?? null,
      question: raw.question,
      strike: raw.strike,
      intervalSec,
      opensAtSec: Number(raw.tradingStart),
      closesAtSec,
      secondsLeft,
      status: onchain.status,
      isTradable,
      onchain,
      raw,
    });
  }

  windows.sort((a, b) => a.secondsLeft - b.secondsLeft);
  return windows;
}

/** The single best window to act on now: soonest to settle that is still tradable. */
export async function getCurrentWindow(
  client: DexClient,
  opts: GetWindowsOptions = {},
): Promise<Window | undefined> {
  const windows = await getWindows(client, opts);
  return windows.find((w) => w.isTradable);
}
