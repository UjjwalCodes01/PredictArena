/**
 * Data access. Every write is an idempotent upsert.
 *
 * That is not tidiness -- it is what makes indexer recovery a restart rather
 * than a repair. Replaying the same settlement, or the same transaction, must
 * converge on the same row, because the reconciler will do exactly that every
 * 45 seconds and again on every startup.
 */
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { Database } from "./client";
import { calls, wallets, windows, syncState } from "./schema";
import type { NewCallRow, NewWindowRow, CallRow, WindowRow } from "./schema";
import { computeStandings } from "./scoring";
import type { CallStatus, ScorableCall, Standing } from "./types";

/** Statuses that will never change again. Everything else is the reconciler's job. */
export const TERMINAL_STATUSES: readonly CallStatus[] = ["WON", "LOST", "VOID", "FAILED"];

const secondsOf = (d: Date): number => Math.floor(d.getTime() / 1000);

/** Upsert a window. Safe to replay: chain values always overwrite ours. */
export async function upsertWindow(db: Database, row: NewWindowRow): Promise<void> {
  await db
    .insert(windows)
    .values(row)
    .onConflictDoUpdate({
      target: windows.id,
      set: {
        status: row.status ?? sql`excluded.status`,
        strike: sql`excluded.strike`,
        winningOutcome: sql`excluded.winning_outcome`,
        resolvedAt: sql`excluded.resolved_at`,
        updatedAt: new Date(),
      },
    });
}

/**
 * Record a call. Keyed on `tx_hash`, so ingesting the same transaction twice
 * updates rather than duplicates.
 */
export async function upsertCall(db: Database, row: NewCallRow): Promise<void> {
  await db
    .insert(calls)
    .values(row)
    .onConflictDoUpdate({
      target: [calls.txHash, calls.windowId, calls.direction],
      set: {
        status: sql`excluded.status`,
        quantity: sql`excluded.quantity`,
        settledAt: sql`excluded.settled_at`,
        payout: sql`excluded.payout`,
        redeemTxHash: sql`excluded.redeem_tx_hash`,
        updatedAt: new Date(),
      },
    });
}

/**
 * Apply a settlement to every call on a window.
 *
 * Derived server-side from the window's outcome -- never from anything a client
 * posted (AGENTS.md section 5: the client never says "I won").
 */
export async function settleCallsForWindow(
  db: Database,
  params: { windowId: string; winningOutcome: number | null; voided: boolean; settledAt: Date },
): Promise<number> {
  const { windowId, winningOutcome, voided, settledAt } = params;

  // Refuse to guess. An earlier version wrote
  //   winningOutcome === 0 ? "UP" : "DOWN"
  // which silently treated a NULL outcome as "Down won" -- marking every Up
  // call LOST and every Down call WON on a window whose result we did not
  // actually know. Fabricating results is worse than settling nothing, so an
  // outcome that is neither 0 nor 1 is an error, not a default.
  if (!voided && winningOutcome !== 0 && winningOutcome !== 1) {
    throw new Error(
      `settleCallsForWindow(${windowId}): winningOutcome must be 0 or 1 when not voided, got ${String(winningOutcome)}`,
    );
  }

  const status = voided
    ? sql`'VOID'::call_status`
    : sql`CASE WHEN ${calls.direction} = ${winningOutcome === 0 ? "UP" : "DOWN"}
                THEN 'WON'::call_status ELSE 'LOST'::call_status END`;

  const updated = await db
    .update(calls)
    .set({ status, settledAt, updatedAt: new Date() })
    .where(and(eq(calls.windowId, windowId), eq(calls.status, "PENDING")))
    .returning({ id: calls.id });

  return updated.length;
}

/**
 * Record a settlement on a window that ALREADY exists.
 *
 * An UPDATE, deliberately not an upsert: the reconciler knows a window id but
 * not the window's asset or week, so an upsert would insert a stub row with
 * empty fields and quietly poison the projection. If the row is missing, that
 * is an ingestion gap to fix, not a hole to paper over -- so we report it.
 */
export async function markWindowSettled(
  db: Database,
  params: { windowId: string; winningOutcome: number | null; voided: boolean; resolvedAt: Date },
): Promise<boolean> {
  const updated = await db
    .update(windows)
    .set({
      status: params.voided ? "VOIDED" : "RESOLVED",
      winningOutcome: params.voided ? null : params.winningOutcome,
      resolvedAt: params.resolvedAt,
      updatedAt: new Date(),
    })
    .where(eq(windows.id, params.windowId))
    .returning({ id: windows.id });
  return updated.length > 0;
}

/**
 * Calls that are still non-terminal -- the reconciler's work list.
 *
 * Paged rather than capped. A bare `limit` silently drops everything past it,
 * and the calls that get dropped are precisely the ones a restart is supposed
 * to recover: the guarantee would quietly stop applying above a threshold
 * nobody was watching.
 */
export async function getNonTerminalCalls(db: Database, maxRows = 20_000): Promise<CallRow[]> {
  return pageAll((offset, size) =>
    db.select().from(calls).where(eq(calls.status, "PENDING"))
      .orderBy(calls.placedAt).limit(size).offset(offset),
    maxRows,
  );
}

const PAGE = 500;

/** Reads every row in pages, stopping at `maxRows` as a runaway guard. */
async function pageAll<T>(
  fetch: (offset: number, size: number) => Promise<T[]>,
  maxRows: number,
): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; offset < maxRows; offset += PAGE) {
    const page = await fetch(offset, Math.min(PAGE, maxRows - offset));
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

/**
 * Pending calls whose window has already closed -- these are overdue for a
 * settlement and are what the 45s poller chases.
 */
export async function getOverdueCalls(db: Database, now: Date, maxRows = 20_000): Promise<CallRow[]> {
  const rows = await pageAll((offset, size) =>
    db.select({ call: calls })
      .from(calls)
      .innerJoin(windows, eq(calls.windowId, windows.id))
      .where(and(eq(calls.status, "PENDING"), lt(windows.closesAt, now)))
      .orderBy(windows.closesAt)
      .limit(size).offset(offset),
    maxRows,
  );
  return rows.map((r) => r.call);
}

/** Windows that have not reached a terminal state. */
export async function getOpenWindows(db: Database, limit = 200): Promise<WindowRow[]> {
  return db
    .select()
    .from(windows)
    .where(or(eq(windows.status, "OPEN"), eq(windows.status, "LOCKED")))
    .orderBy(desc(windows.closesAt))
    .limit(limit);
}

/**
 * Addresses are stored LOWERCASE, everywhere.
 *
 * Chain reads return them lowercase; wagmi and viem hand back EIP-55 checksum
 * casing. Storing one and querying with the other silently matches nothing, so
 * every address crossing this boundary is normalised. Display code re-applies
 * checksum casing at the edge.
 */
export const normalizeAddress = (address: string): string => address.trim().toLowerCase();

export async function touchWallet(db: Database, address: string): Promise<void> {
  const now = new Date();
  await db
    .insert(wallets)
    .values({ address: normalizeAddress(address), firstSeenAt: now, lastSeenAt: now })
    .onConflictDoUpdate({ target: wallets.address, set: { lastSeenAt: now } });
}

export async function getSyncState(db: Database, key: string) {
  const [row] = await db.select().from(syncState).where(eq(syncState.key, key)).limit(1);
  return row ?? null;
}

export async function setSyncState(
  db: Database,
  key: string,
  value: { blockNumber?: bigint; cursor?: string },
): Promise<void> {
  await db
    .insert(syncState)
    .values({ key, blockNumber: value.blockNumber ?? null, cursor: value.cursor ?? null, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: syncState.key,
      set: { blockNumber: sql`excluded.block_number`, cursor: sql`excluded.cursor`, updatedAt: new Date() },
    });
}

/** Raw calls for a week, shaped for the pure scoring engine. */
export async function getScorableCalls(db: Database, weekId: string): Promise<ScorableCall[]> {
  const rows = await db
    .select({
      id: calls.id,
      wallet: calls.wallet,
      windowId: calls.windowId,
      direction: calls.direction,
      status: calls.status,
      placedAt: calls.placedAt,
      weekId: calls.weekId,
      closesAt: windows.closesAt,
    })
    .from(calls)
    .innerJoin(windows, eq(calls.windowId, windows.id))
    .where(eq(calls.weekId, weekId));

  return rows.map((r) => ({
    id: r.id,
    wallet: r.wallet,
    windowId: r.windowId,
    direction: r.direction,
    status: r.status,
    placedAtSec: secondsOf(r.placedAt),
    closesAtSec: secondsOf(r.closesAt),
    weekId: r.weekId,
  }));
}

/**
 * The leaderboard.
 *
 * Deliberately computed from raw calls on every read rather than stored: points
 * are derived data, so a reorg or a late correction is a recompute, not a
 * repair. At league scale this is a small query and a pure function.
 */
export async function getStandings(db: Database, weekId: string): Promise<Standing[]> {
  return computeStandings(await getScorableCalls(db, weekId), weekId);
}

/** Every call a wallet has made, newest first. Powers the profile page. */
export async function getWalletCalls(db: Database, wallet: string, limit = 100): Promise<CallRow[]> {
  return db
    .select()
    .from(calls)
    .where(eq(calls.wallet, normalizeAddress(wallet)))
    .orderBy(desc(calls.placedAt))
    .limit(limit);
}

/** Windows by id, for reconciling a batch of calls in one round trip. */
export async function getWindowsByIds(db: Database, ids: readonly string[]): Promise<WindowRow[]> {
  if (ids.length === 0) return [];
  return db.select().from(windows).where(inArray(windows.id, [...ids]));
}
