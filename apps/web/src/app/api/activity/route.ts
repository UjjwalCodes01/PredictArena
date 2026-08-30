import { NextResponse } from "next/server";
import { getRecentCalls, getLeagueTotals, currentWeekId, getDisplayNames } from "@predictarena/db";
import { serverDb, dbRead } from "@/lib/server";
import { cached } from "@/lib/cache";

export const dynamic = "force-dynamic";

/**
 * The public activity feed: what everyone has been calling, newest first.
 *
 * Everything here is already public on-chain -- this is a readable view of it,
 * not a disclosure.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const settledOnly = searchParams.get("settled") === "1";

  try {
    const db = serverDb();
    const week = currentWeekId();
    const [rows, totals] = await Promise.all([
      cached(`recent:${settledOnly}`, 6_000, () => dbRead(() => getRecentCalls(db, { limit: 50, settledOnly }))),
      cached(`totals:${week}`, 6_000, () => dbRead(() => getLeagueTotals(db, week))),
    ]);

    const names = await cached(`names:recent:${settledOnly}`, 6_000, () =>
      dbRead(() => getDisplayNames(db, rows.map((r) => r.wallet))),
    );

    return NextResponse.json(
      {
        weekId: week,
        totals,
        calls: rows.map((r) => ({
          id: r.id,
          wallet: r.wallet,
          displayName: names.get(r.wallet) ?? null,
          windowId: r.windowId,
          asset: r.asset,
          direction: r.direction,
          status: r.status,
          stake: r.stake,
          quantity: r.quantity,
          txHash: r.txHash,
          placedAt: r.placedAt.toISOString(),
          settledAt: r.settledAt ? r.settledAt.toISOString() : null,
          closesAtSec: Math.floor(r.closesAt.getTime() / 1000),
          intervalSec: r.intervalSec,
          weekId: r.weekId,
        })),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json(
      {
        code: "API_DOWN",
        message: e instanceof Error ? e.message : "Could not load activity.",
        action: "Retry in a moment.",
      },
      { status: 503 },
    );
  }
}
