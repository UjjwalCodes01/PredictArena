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
import type { DexClient } from "./client";
import { asDexError } from "./errors";

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

/**
 * How long one candidate's on-chain read may take before it is abandoned.
 *
 * A healthy read measured 1.2-2.5s, so this is generous for a good market and
 * short for a dead one.
 */
const CANDIDATE_READ_TIMEOUT_MS = 5_000;

/** Reject rather than hang. The caller treats a rejection as "skip this one". */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`read exceeded ${ms}ms`)), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/**
 * The minimum needed to rebuild a window WITHOUT the venue's indexer.
 *
 * Only the fields the chain cannot supply. Everything authoritative — pool,
 * status, expiry, resolution — is read on-chain regardless of what a caller
 * passes here.
 */
export interface WindowCandidate {
  readonly marketId: `0x${string}`;
  readonly asset: string;
  readonly venueId?: string | null;
  readonly intervalSec?: number | null;
  readonly strike?: string | null;
  readonly opensAtSec?: number | null;
  readonly question?: string | null;
}

/**
 * Build windows from candidate ids, using the chain alone.
 *
 * The venue's GraphQL indexer is a single point of failure for the entire
 * product: `listLiveBinaryMarkets` is the only way to learn which markets
 * exist, and when it stops answering — measured: a bare `Market(limit:1){id}`
 * timing out at 31s while an invalid field errored in 1.6s — nobody can see a
 * window, so nobody can place a call.
 *
 * The chain does not have that problem. Given ids from somewhere else (our own
 * projection), every fact that matters for trading can be read directly, and
 * `getMarketOnchain` answers in ~1-2s.
 *
 * This does NOT weaken the source-of-truth rule. Status, pool and expiry come
 * from the chain here exactly as they do on the fast path; the candidate list
 * only decides which markets to LOOK at. A stale id costs one wasted read, and
 * a window that has since closed is reported closed, because the chain says so.
 */
export async function getWindowsFromCandidates(
  client: DexClient,
  candidates: readonly WindowCandidate[],
  opts: { includeUntradable?: boolean } = {},
): Promise<Window[]> {
  await client.clock.ensureFresh();

  const settled = await Promise.all(
    candidates.map(async (c) => {
      try {
        // Deliberately NOT through `client.queue`. Its retry-with-backoff is
        // right for the fast path, but here the candidate list comes from a
        // projection that may name markets which no longer exist — and every
        // one of those was retried, turning twelve reads into twenty-one
        // seconds. This is a fallback running against a deadline: a candidate
        // that does not answer promptly is skipped, not chased.
        const onchain = await withTimeout(
          client.exchange.client.getMarketOnchain(c.marketId),
          CANDIDATE_READ_TIMEOUT_MS,
        );
        return { c, onchain };
      } catch {
        // A window we cannot read on-chain is a window we must not trade.
        return null;
      }
    }),
  );

  const windows: Window[] = [];
  for (const entry of settled) {
    if (!entry) continue;
    const { c, onchain } = entry;

    // Expiry from the CHAIN, not from the candidate: a projection can lag, and
    // the countdown is the one number a player acts on.
    const closesAtSec = Number(onchain.expiry);
    const secondsLeft = client.clock.secondsUntil(closesAtSec);
    const intervalSec = c.intervalSec ?? null;
    const isTradable =
      onchain.status === MarketStatus.Trading &&
      secondsLeft >= headroomSecFor(intervalSec ?? 0);

    if (!isTradable && !opts.includeUntradable) continue;

    windows.push({
      marketId: c.marketId,
      asset: c.asset,
      pool: onchain.pool,
      venueId: c.venueId ?? null,
      // The venue's own question text has changed format three times in a week
      // (docs/dex-notes.md), so it was never load-bearing. Stating the series
      // plainly is more useful than echoing a string we cannot rely on.
      question: c.question ?? `Will ${c.asset} close at or above its opening price?`,
      strike: c.strike ?? "0",
      intervalSec,
      opensAtSec: c.opensAtSec ?? closesAtSec - (intervalSec ?? 0),
      closesAtSec,
      secondsLeft,
      status: onchain.status,
      isTradable,
      onchain,
      // No indexer row exists on this path. Callers use the typed fields above;
      // `raw` is only ever read by code that already has an indexer row.
      raw: undefined as unknown as BinaryMarket,
    });
  }

  windows.sort((a, b) => a.closesAtSec - b.closesAtSec);
  return windows;
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

/**
 * One window by id.
 *
 * `/api/quote` used to call `getWindows({ limit: 60 })` and then find its
 * market in the result -- sixty chain reads to price one call. This reads the
 * single row and the single on-chain status instead.
 */
export async function getWindow(client: DexClient, marketId: `0x${string}`): Promise<Window | null> {
  await client.clock.ensureFresh();
  try {
    const [raw, onchain] = await Promise.all([
      client.queue.run(() => client.exchange.client.getBinaryMarket(marketId)),
      client.queue.run(() => client.exchange.client.getMarketOnchain(marketId)),
    ]);
    if (!raw) return null;

    const closesAtSec = Number(raw.expiry);
    const secondsLeft = client.clock.secondsUntil(closesAtSec);
    const intervalSec = raw.intervalSec != null ? Number(raw.intervalSec) : null;

    return {
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
      isTradable:
        onchain.status === MarketStatus.Trading && secondsLeft >= headroomSecFor(intervalSec ?? 0),
      onchain,
      raw,
    };
  } catch (e) {
    throw asDexError(e, "API_DOWN");
  }
}

/** The single best window to act on now: soonest to settle that is still tradable. */
export async function getCurrentWindow(
  client: DexClient,
  opts: GetWindowsOptions = {},
): Promise<Window | undefined> {
  const windows = await getWindows(client, opts);
  return windows.find((w) => w.isTradable);
}
