import { NextResponse } from "next/server";
import { getSyncState, currentWeekId } from "@predictarena/db";
import { serverDb, serverDex, dbRead, withDeadline } from "@/lib/server";
import { windowsFor, venueDegraded } from "@/lib/windows";
import { rateLimit, clientKey, tooManyRequests } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
/**
 * `windowsFor` pays the venue's own timeout (~7s) once before falling back to
 * reading the chain directly (up to ~25s more). The platform default would
 * kill this function before that fallback finishes.
 */
export const maxDuration = 60;

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
 *   chain    — can a player actually see windows right now
 *
 * The chain check goes through `windowsFor` — the exact path `/api/windows`
 * uses, fallback included — rather than a raw venue call. It used to call the
 * venue directly, and a venue hiccup made health report "down" while the site
 * itself kept working: measured in production, the raw call timed out at 20s
 * while `/api/windows` served real windows in 9s via the chain fallback. A
 * check that alarms on an outage the product already survived gets muted,
 * which is worse than no check, so it now reports what the check exists to
 * report — a THIRD state, "degraded", for exactly that case: the site works,
 * but the venue is not the one serving it right now.
 *
 * HTTP status stays binary for a plain uptime monitor: 200 for ok or
 * degraded (the site works either way), 503 only for a real down.
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

/**
 * The chain check, kept out of `timed()` because it is the one check with
 * three possible outcomes rather than two.
 */
async function checkChain(): Promise<Check> {
  const started = Date.now();
  try {
    // An outer bound independent of windowsFor's own internal deadlines —
    // defense in depth, so a health request itself cannot hang past this
    // regardless of what changes inside that function later.
    const windows = await withDeadline("chainCheck", 35_000, () => windowsFor(serverDex()));
    if (windows.length === 0) {
      // Genuinely nothing listed at all — that IS a venue problem, fallback
      // included: an empty candidate list falls through to an empty result.
      throw new Error("venue listed no markets at all");
    }
    const tradable = windows.filter((w) => w.isTradable).length;
    const degraded = venueDegraded();
    return {
      status: degraded ? "degraded" : "ok",
      detail: degraded
        ? `${windows.length} markets, ${tradable} tradable — venue indexer unreachable, served from chain`
        : `${windows.length} markets, ${tradable} tradable`,
      ms: Date.now() - started,
    };
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
    checkChain(),
  ]);

  const checks = { database, indexer, chain };
  const statuses = Object.values(checks).map((c) => c.status);
  const worst: Status = statuses.includes("down")
    ? "down"
    : statuses.includes("degraded")
      ? "degraded"
      : "ok";

  return NextResponse.json(
    {
      status: worst,
      week: currentWeekId(),
      checks,
      // Present so a monitor can distinguish an old cached answer from a fresh one.
      at: new Date().toISOString(),
    },
    {
      // Binary for a plain uptime monitor: the site works in both ok and
      // degraded, so only a real down pages anyone.
      status: worst === "down" ? 503 : 200,
      headers: { "cache-control": "no-store" },
    },
  );
}
