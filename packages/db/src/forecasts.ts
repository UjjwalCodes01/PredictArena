/**
 * Reads and writes for the AI forecaster's reasoning log.
 *
 * Kept apart from `queries.ts` because it answers a different question. Every
 * function there returns a projection of chain truth; these return what a model
 * asserted before the outcome existed. Nothing here is ever consulted to decide
 * whether a call won — that is read from `calls`, like everyone else's.
 */
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Database } from "./client";
import { forecasts, windows } from "./schema";
import type { ForecastRow, NewForecastRow } from "./schema";

/** Composite key. One estimate per forecaster per window. */
export function forecastId(wallet: string, windowId: string): string {
  return `${wallet.toLowerCase()}:${windowId.toLowerCase()}`;
}

/**
 * Record an estimate.
 *
 * Deliberately insert-or-ignore rather than upsert: a forecast is a claim made
 * at a moment, and letting a later pass overwrite it would allow the record to
 * be quietly improved after the market moved. First answer stands.
 */
export async function recordForecast(db: Database, row: NewForecastRow): Promise<void> {
  await db.insert(forecasts).values(row).onConflictDoNothing({ target: forecasts.id });
}

/**
 * Attach a transaction hash to a forecast whose order landed.
 *
 * The only field that may be written after the fact, because it records
 * something that happened later. It cannot change the estimate or the edge.
 */
export async function linkForecastTx(
  db: Database,
  id: string,
  txHash: string,
): Promise<void> {
  await db.update(forecasts).set({ txHash }).where(eq(forecasts.id, id));
}

/** Which of these windows has this forecaster already seen? */
export async function forecastedWindowIds(
  db: Database,
  wallet: string,
  windowIds: readonly string[],
): Promise<Set<string>> {
  if (windowIds.length === 0) return new Set();
  const rows = await db
    .select({ windowId: forecasts.windowId })
    .from(forecasts)
    .where(and(eq(forecasts.wallet, wallet.toLowerCase()), inArray(forecasts.windowId, [...windowIds])));
  return new Set(rows.map((r) => r.windowId));
}

/** Most recent estimates, newest first. */
export async function getRecentForecasts(
  db: Database,
  wallet: string,
  limit = 40,
): Promise<ForecastRow[]> {
  return db
    .select()
    .from(forecasts)
    .where(eq(forecasts.wallet, wallet.toLowerCase()))
    .orderBy(desc(forecasts.createdAt))
    .limit(Math.min(limit, 200));
}

/** The estimate for one window, if there is one. */
export async function getForecastForWindow(
  db: Database,
  wallet: string,
  windowId: string,
): Promise<ForecastRow | null> {
  const rows = await db
    .select()
    .from(forecasts)
    .where(eq(forecasts.id, forecastId(wallet, windowId)))
    .limit(1);
  return rows[0] ?? null;
}

/** Estimates for several windows at once, keyed by window id. */
export async function getForecastsForWindows(
  db: Database,
  wallet: string,
  windowIds: readonly string[],
): Promise<Map<string, ForecastRow>> {
  if (windowIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(forecasts)
    .where(and(eq(forecasts.wallet, wallet.toLowerCase()), inArray(forecasts.windowId, [...windowIds])));
  return new Map(rows.map((r) => [r.windowId, r]));
}

export interface ForecastSummary {
  readonly total: number;
  readonly placed: number;
  readonly passed: number;
}

/**
 * How often it acts.
 *
 * The pass rate is the honest headline for a forecaster: one that trades every
 * window has no threshold and is a coin flip with a rationale attached.
 */
export async function getForecastSummary(db: Database, wallet: string): Promise<ForecastSummary> {
  const rows = await db
    .select({ action: forecasts.action, n: sql<number>`count(*)::int` })
    .from(forecasts)
    .where(eq(forecasts.wallet, wallet.toLowerCase()))
    .groupBy(forecasts.action);

  let placed = 0;
  let passed = 0;
  for (const r of rows) {
    if (r.action === "PLACE") placed = Number(r.n);
    else passed = Number(r.n);
  }
  return { total: placed + passed, placed, passed };
}

/**
 * How the last few windows on a series actually resolved.
 *
 * The forecaster's only local evidence. Lives here rather than in `queries.ts`
 * because it exists to be put in front of a model: it returns outcomes, not
 * rows, and deliberately carries nothing a prompt has no business seeing.
 */
export async function getResolvedHistory(
  db: Database,
  asset: string,
  limit = 12,
): Promise<Array<{ closedAtSec: number; outcome: "UP" | "DOWN" | "VOID" }>> {
  const rows = await db
    .select({
      closesAt: windows.closesAt,
      status: windows.status,
      winningOutcome: windows.winningOutcome,
    })
    .from(windows)
    .where(and(eq(windows.asset, asset), isNotNull(windows.resolvedAt)))
    .orderBy(desc(windows.closesAt))
    .limit(Math.min(limit, 50));

  return rows.map((r) => ({
    closedAtSec: Math.floor(r.closesAt.getTime() / 1000),
    // 0 = Up, 1 = Down on chain. A voided window has no outcome at all, and
    // showing it as a direction would invent evidence the model would use.
    outcome:
      r.status === "VOIDED" || r.winningOutcome === null
        ? ("VOID" as const)
        : r.winningOutcome === 0
          ? ("UP" as const)
          : ("DOWN" as const),
  }));
}
