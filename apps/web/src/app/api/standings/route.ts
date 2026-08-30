import { NextResponse } from "next/server";
import { getStandings, currentWeekId, weekStartUtc, getDisplayNames } from "@predictarena/db";
import { serverDb, dbRead } from "@/lib/server";
import { rateLimit, clientKey, tooManyRequests } from "@/lib/rateLimit";
import { cached } from "@/lib/cache";
import type { StandingsResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

const WEEK_ID = /^\d{4}-W\d{2}$/;

/**
 * The leaderboard for one league week.
 *
 * Parameterised by week so a rollover mid-view cannot silently swap the table
 * underneath the reader, and so the week switcher has something to switch to.
 * Standings are recomputed from raw calls on every read -- points are derived
 * data, so a late correction is a recompute rather than a repair.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const limit = rateLimit(clientKey(request), { capacity: 40, refillPerSec: 2 });
  if (!limit.ok) return tooManyRequests(limit) as never;

  const { searchParams } = new URL(request.url);
  const requested = searchParams.get("week");

  if (requested && !WEEK_ID.test(requested)) {
    return NextResponse.json(
      { code: "BAD_REQUEST", message: "week must look like 2026-W35." },
      { status: 400 },
    );
  }
  const weekId = requested ?? currentWeekId();

  try {
    const db = serverDb();
    // 6s. Standings only move when a call settles, and the database is a
    // serverless instance an ocean away -- the first request after it suspends
    // paid seventeen seconds. Exactly one visitor should ever pay that.
    const standings = await cached(`standings:${weekId}`, 6_000, () =>
      dbRead(() => getStandings(db, weekId)),
    );
    const names = await cached(`names:${weekId}`, 6_000, () =>
      dbRead(() => getDisplayNames(db, standings.map((s) => s.wallet))),
    );
    const body: StandingsResponse = {
      weekId,
      weekStartIso: weekStartUtc(weekId).toISOString(),
      standings: standings.map((s) => ({ ...s, displayName: names.get(s.wallet) ?? null })),
    };
    return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json(
      {
        code: "API_DOWN",
        message: e instanceof Error ? e.message : "Could not load the leaderboard.",
        action: "Retry in a moment.",
      },
      { status: 503 },
    );
  }
}
