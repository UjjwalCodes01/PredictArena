/**
 * Call ingestion -- derived from chain fills, never from anything a client says.
 *
 * AGENTS.md section 5 is explicit: position writes come only from the indexer's
 * own chain reads, keyed by the wallet recovered from the chain. So a "call" is
 * discovered here by reading the venue's fills, not by a browser posting "I
 * placed a bet". Nothing a user sends could fabricate a position.
 *
 * Two modelling decisions worth stating:
 *
 *  1. **One user action is one call.** An order can sweep several price levels
 *     and produce several fills sharing a transaction. Those are aggregated
 *     into a single call, because the player tapped once.
 *
 *  2. **Takers only.** A resting maker also holds a position, but on this venue
 *     makers are market-making bots, and our own app only ever places taker
 *     orders. Counting makers would put bots on the league table.
 */
import type { DexClient } from "@predictarena/dex";
import { upsertCall, touchWallet, weekIdForClose, normalizeAddress, type Database, type NewCallRow, getRecentlyClosedWindows } from "@predictarena/db";
import type { CallStatus, Direction } from "@predictarena/db";
import { log } from "./log";

/** Page size per fills request. Pagination continues until a short page. */
const FILLS_PAGE = 200;
/** Hard stop, so a pathological window cannot spin the loop forever. */
const FILLS_MAX_PAGES = 25;

/**
 * All fills for a pool, following pagination.
 *
 * AGENTS.md section 5: "always follow pagination; never assume one page." Live
 * windows currently carry a handful of fills, so a single page would work
 * today -- but a busy demo window is exactly when silently dropping the tail
 * would cost us calls, and a dropped call is a missing league entry.
 */
async function fetchAllFills(dex: DexClient, pool: `0x${string}`) {
  const all: Awaited<ReturnType<DexClient["exchange"]["client"]["getFills"]>> = [];
  for (let page = 0; page < FILLS_MAX_PAGES; page += 1) {
    const batch = await dex.queue.run(() =>
      dex.exchange.client.getFills(pool, { limit: FILLS_PAGE, offset: page * FILLS_PAGE }),
    );
    all.push(...batch);
    // A short page means we reached the end.
    if (batch.length < FILLS_PAGE) return all;
  }
  log.warn({ pool, pages: FILLS_MAX_PAGES }, "fills pagination hit its page cap; tail may be missing");
  return all;
}

/** Only a BUY opens a position; a SELL is closing one, not making a call. */
export function directionOf(side: string | null): Direction | null {
  if (side === "BUY_YES") return "UP";
  if (side === "BUY_NO") return "DOWN";
  return null;
}

/** What call ingestion needs about a window, read once by the caller. */
export interface IngestTarget {
  marketId: string;
  pool: `0x${string}`;
  asset: string;
  closesAtSec: number;
  resolved: boolean;
  voided: boolean;
  winningOutcome: number;
}

export interface Aggregated {
  txHash: string;
  wallet: string;
  direction: Direction;
  quantity: bigint;
  stake: bigint;
  placedAtSec: number;
}

/** The fill fields aggregation depends on. Structural, so tests need no SDK. */
export interface FillLike {
  taker: string | null;
  takerSide: string | null;
  takerOrder?: { owner: string; side: string | null } | null;
  quantity: string;
  quoteQuantity: string;
  timestamp: string;
  txHash: string;
}

/**
 * Collapse fills into one call per (transaction, direction).
 *
 * An order can sweep several price levels, producing several fills that share a
 * transaction. Those are ONE call: the player tapped once. Amounts sum; the
 * placement time is the earliest fill. Anything that is not a taker BUY is
 * skipped -- a maker is a bot, and a SELL closes a position rather than making
 * a call.
 */
export function aggregateFills(fills: readonly FillLike[], normalize: (a: string) => string): Map<string, Aggregated> {
  const byCall = new Map<string, Aggregated>();
  for (const f of fills) {
    const taker = f.taker ?? f.takerOrder?.owner ?? null;
    const direction = directionOf(f.takerSide ?? f.takerOrder?.side ?? null);
    if (!taker || !direction || !f.txHash) continue;

    const key = `${f.txHash}:${direction}`;
    const placedAtSec = Number(f.timestamp);
    const existing = byCall.get(key);
    if (existing) {
      existing.quantity += BigInt(f.quantity);
      existing.stake += BigInt(f.quoteQuantity);
      existing.placedAtSec = Math.min(existing.placedAtSec, placedAtSec);
    } else {
      byCall.set(key, {
        txHash: f.txHash,
        wallet: normalize(taker),
        direction,
        quantity: BigInt(f.quantity),
        stake: BigInt(f.quoteQuantity),
        placedAtSec,
      });
    }
  }
  return byCall;
}

export interface IngestCallsResult {
  windowsScanned: number;
  fillsSeen: number;
  callsWritten: number;
  errors: number;
}

/**
 * Read fills for the given windows and record the calls they represent.
 *
 * Idempotent: re-reading the same fills upserts the same rows, which is what
 * lets this run every cycle and after every restart without care.
 */
export async function ingestCalls(
  dex: DexClient,
  db: Database,
  windows: ReadonlyArray<IngestTarget>,
): Promise<IngestCallsResult> {
  const result: IngestCallsResult = { windowsScanned: 0, fillsSeen: 0, callsWritten: 0, errors: 0 };

  // Fills read concurrently: sequentially this was ~1.6s per window, which does
  // not fit a 20s cycle once there are a dozen live windows.
  const reads = await Promise.all(
    windows.map(async (w) => {
      try {
        return { w, fills: await fetchAllFills(dex, w.pool) };
      } catch (e) {
        log.warn({ marketId: w.marketId, err: e instanceof Error ? e.message : String(e) }, "fills read failed");
        return { w, fills: null };
      }
    }),
  );

  for (const { w, fills } of reads) {
    result.windowsScanned += 1;
    if (!fills) { result.errors += 1; continue; }
    result.fillsSeen += fills.length;
    if (fills.length === 0) continue;

    const byCall = aggregateFills(fills as unknown as FillLike[], normalizeAddress);
    if (byCall.size === 0) continue;

    // The caller already read this window's on-chain state, so use it rather
    // than paying for the same read again. Where it is still unsettled the row
    // stays PENDING and the reconciler owns it -- never guess an outcome.
    let settledStatus: ((d: Direction) => CallStatus) | null = null;
    let settledAt: Date | null = null;
    if (w.voided) {
      settledStatus = () => "VOID";
      settledAt = new Date();
    } else if (w.resolved) {
      const winner: Direction = w.winningOutcome === 0 ? "UP" : "DOWN";
      settledStatus = (d) => (d === winner ? "WON" : "LOST");
      settledAt = new Date();
    }

    for (const c of byCall.values()) {
      const row: NewCallRow = {
        // The window belongs in the identity: one batch transaction can trade
        // two windows in the same direction, and those are two calls.
        id: `${c.txHash}:${w.marketId}:${c.direction}`,
        wallet: c.wallet,
        windowId: w.marketId,
        asset: w.asset,
        direction: c.direction,
        stake: c.stake.toString(),
        quantity: c.quantity.toString(),
        txHash: c.txHash,
        status: settledStatus ? settledStatus(c.direction) : "PENDING",
        placedAt: new Date(c.placedAtSec * 1000),
        settledAt,
        weekId: weekIdForClose(w.closesAtSec),
      };
      try {
        await touchWallet(db, c.wallet);
        await upsertCall(db, row);
        result.callsWritten += 1;
      } catch (e) {
        result.errors += 1;
        log.warn(
          { txHash: c.txHash, wallet: c.wallet, err: e instanceof Error ? e.message : String(e) },
          "call upsert failed",
        );
      }
    }
  }

  return result;
}

/**
 * Catch-up sweep for windows the venue no longer lists.
 *
 * The normal cycle can only see LIVE windows. A window that closed while the
 * indexer was restarting, or during any gap in its uptime, drops off that list
 * within minutes and its fills become unreachable -- so every call placed on it
 * is lost from the projection permanently, and those players silently vanish
 * from the leaderboard.
 *
 * This reads recently-closed windows from OUR OWN table, where the pool address
 * was stored at ingest time, and re-scans their fills. Ingestion is idempotent
 * (calls are keyed on the fill), so re-scanning a window we already have is
 * harmless and cheap.
 */
export async function catchUpClosedWindows(
  dex: DexClient,
  db: Database,
  sinceMinutes = 180,
): Promise<IngestCallsResult> {
  const rows = await getRecentlyClosedWindows(db, sinceMinutes);
  if (rows.length === 0) {
    return { windowsScanned: 0, fillsSeen: 0, callsWritten: 0, errors: 0 };
  }

  const targets: IngestTarget[] = rows.map((r) => ({
    marketId: r.id,
    pool: r.pool as `0x${string}`,
    asset: r.asset,
    closesAtSec: Math.floor(r.closesAt.getTime() / 1000),
    // Settlement state is reconciled separately; ingestion only needs the fills.
    resolved: false,
    voided: false,
    winningOutcome: 0,
  }));

  return ingestCalls(dex, db, targets);
}
