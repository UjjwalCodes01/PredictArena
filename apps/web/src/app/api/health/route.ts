import { NextResponse } from "next/server";
import { getSyncState, currentWeekId } from "@predictarena/db";
import { getWindows } from "@predictarena/dex";
import { serverDb, serverDex, dbRead, withDeadline } from "@/lib/server";
import { rateLimit, clientKey, tooManyRequests } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

/**
 * Machine-readable health, for an uptime monitor to poll.
 *
 * Phase 4 asks that a dead indexer be noticed within minutes rather than at
 * demo time. That cannot be done by pinging the home page: the site renders
 * perfectly while the projection quietly goes hours stale — which is exactly
 * how it failed in practice.
 *
 * So this checks the things that can independently break:
 *
 *   database — can we read at all
 *   indexer  — has it reported recently
 *   chain    — is the venue reachable and serving live windows
 *
 * Returns 200 only when everything is healthy, and 503 otherwise, so a plain
 * HTTP uptime check (UptimeRobot, Better Stack, a curl in cron) alerts without
 * needing to parse the body.
 */

/** The indexer heartbeats every 30s; three missed beats is a real problem. */
const INDEXER_STALE_SEC = 150;

type Status = "ok" | "degraded" | "down";

interface Check {
  status: Status;
  detail: string;
  ms: number;
}

async function timed(fn: () => Promise<string>): Promise<Check> {
  const started = Date.now();
  try {
    const detail = await fn();
    return { status: "ok", detail, ms: Date.now() - started };
  } catch (e) {
    return {
      status: "down",
      detail: e instanceof Error ? e.message.slice(0, 120) : "failed",
      ms: Date.now() - started,
    };
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  const limit = rateLimit(clientKey(request), { capacity: 30, refillPerSec: 1 });
  if (!limit.ok) return tooManyRequests(limit) as never;

  const [database, indexer, chain] = await Promise.all([
    timed(async () => {
      await dbRead(() => getSyncState(serverDb(), "heartbeat"));
      return "reachable";
    }),
    timed(async () => {
      const hb = await dbRead(() => getSyncState(serverDb(), "heartbeat"));
      const cursor = (hb as { cursor?: string } | null)?.cursor;
      if (!cursor) throw new Error("indexer has never reported");
      const ageSec = Math.round((Date.now() - new Date(cursor).getTime()) / 1000);
      if (ageSec > INDEXER_STALE_SEC) {
        throw new Error(`last reported ${ageSec}s ago; results are stale`);
      }
      return `reported ${ageSec}s ago`;
    }),
    timed(async () => {
      /*
       * Ask whether the venue ANSWERS, not whether it currently has tradable
       * windows.
       *
       * This used to call `getWindows({ limit: 5 })` and fail on an empty
       * result. `limit` is a fetch budget applied BEFORE the tradable filter,
       * so a healthy venue whose first five rows happen to be mid-roll
       * returned zero — and the check reported "chain down" while
       * /api/windows was serving three windows perfectly well.
       *
       * A monitor that cries wolf gets muted, which is worse than no monitor.
       * So: reachable and answering is healthy. Having nothing tradable right
       * now is a fact about the schedule, and it is reported rather than
       * treated as an outage.
       */
      const windows = await withDeadline("getWindows", 20_000, () =>
        getWindows(serverDex(), { includeUntradable: true, limit: 20 }),
      );
      if (windows.length === 0) {
        // Genuinely nothing listed at all — that IS a venue problem.
        throw new Error("venue listed no markets at all");
      }
      const tradable = windows.filter((w) => w.isTradable).length;
      return `${windows.length} markets, ${tradable} tradable`;
    }),
  ]);

  const checks = { database, indexer, chain };
  const worst: Status = Object.values(checks).some((c) => c.status === "down") ? "down" : "ok";

  return NextResponse.json(
    {
      status: worst,
      week: currentWeekId(),
      checks,
      // Present so a monitor can distinguish an old cached answer from a fresh one.
      at: new Date().toISOString(),
    },
    {
      status: worst === "ok" ? 200 : 503,
      headers: { "cache-control": "no-store" },
    },
  );
}
