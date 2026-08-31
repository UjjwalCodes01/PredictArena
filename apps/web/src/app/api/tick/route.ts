import { NextResponse } from "next/server";
import { getSyncState, setSyncState } from "@predictarena/db";
import { ingestWindows, ingestCalls, catchUpClosedWindows, reconcile } from "@predictarena/indexer";
import { serverDb, serverDex, dbRead, withDeadline } from "@/lib/server";
import { rateLimit, clientKey, tooManyRequests } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Traffic-driven ingestion. No secret, no scheduler, no extra hosting.
 *
 * The indexer is a daemon, and there is nowhere free and reliable to run one:
 * Vercel runs functions, and GitHub's scheduler demonstrably drops runs — one
 * fired in eight hours against a five-minute cadence.
 *
 * So the site keeps itself fresh. Anyone loading a page pokes this; if the
 * projection has gone stale it runs ONE cycle, otherwise it returns
 * immediately. The property that makes this work: a demo is exactly when
 * people are looking at the site, which is exactly when it stays fresh.
 *
 * Why it is safe to leave unauthenticated:
 *
 *  - It does nothing unless the projection is actually stale, so hammering it
 *    is a no-op, not an amplification.
 *  - A module-level lock means one cycle at a time per instance.
 *  - It writes nothing a caller controls — every value comes from chain reads.
 *  - It is rate-limited like every other route.
 *
 * This does NOT replace running the daemon. It reacts on page views rather
 * than in seconds, and an idle site drifts. It is the difference between
 * "stale unless someone deployed a worker" and "fresh whenever anyone looks".
 */

/** Older than this and a page view should trigger a cycle. */
const STALE_AFTER_MS = 150_000;

/**
 * One cycle at a time per instance, with an EXPIRY.
 *
 * A plain boolean deadlocks: if the request is aborted mid-cycle — the client
 * disconnects, the platform reclaims the function — the `finally` never runs
 * and the flag stays set, disabling ingestion on that instance forever. Seen
 * in testing: one interrupted call and every later tick answered "already
 * running" indefinitely.
 *
 * A timestamp cannot get stuck. Past the lease, the lock is simply gone.
 */
let runningSince = 0;
const LOCK_LEASE_MS = 90_000;

/** Cheap guard against re-running the instant a cycle finishes. */
let lastRunAt = 0;
const MIN_GAP_MS = 30_000;

export async function GET(request: Request): Promise<NextResponse> {
  const limit = rateLimit(`tick:${clientKey(request)}`, { capacity: 6, refillPerSec: 0.2 });
  if (!limit.ok) return tooManyRequests(limit) as never;

  const db = serverDb();

  let ageMs: number | null = null;
  try {
    const hb = await dbRead(() => getSyncState(db, "heartbeat"));
    const cursor = (hb as { cursor?: string } | null)?.cursor;
    ageMs = cursor ? Date.now() - new Date(cursor).getTime() : Number.MAX_SAFE_INTEGER;
  } catch {
    // If we cannot even read the heartbeat, running a cycle will not help.
    return NextResponse.json({ ran: false, reason: "database unreachable" }, { status: 503 });
  }

  if (ageMs < STALE_AFTER_MS) {
    return NextResponse.json(
      { ran: false, reason: "fresh", ageSec: Math.round(ageMs / 1000) },
      { headers: { "cache-control": "no-store" } },
    );
  }
  const lockHeld = runningSince > 0 && Date.now() - runningSince < LOCK_LEASE_MS;
  if (lockHeld || Date.now() - lastRunAt < MIN_GAP_MS) {
    return NextResponse.json(
      { ran: false, reason: lockHeld ? "already running" : "just ran" },
      { headers: { "cache-control": "no-store" } },
    );
  }

  runningSince = Date.now();
  const started = Date.now();
  const BUDGET_MS = 45_000;
  const room = (need: number): boolean => Date.now() - started + need < BUDGET_MS;
  const done: Record<string, number> = {};

  try {
    const dex = serverDex();
    // Bounded: this leg is not optional, but it is also not allowed to consume
    // the whole budget and leave nothing for settlement.
    const windows = await withDeadline("ingestWindows", 25_000, () =>
      ingestWindows(dex, db, ["BTC", "ETH"]),
    );
    done["windows"] = windows.written;

    if (room(15_000)) done["calls"] = (await ingestCalls(dex, db, windows.windows)).callsWritten;
    if (room(10_000)) done["settled"] = (await reconcile(dex, db, "overdue")).callsSettled;
    if (room(15_000)) done["recovered"] = (await catchUpClosedWindows(dex, db, 60)).callsWritten;

    const now = new Date().toISOString();
    await setSyncState(db, "ingest", { cursor: now });
    await setSyncState(db, "heartbeat", { cursor: now });

    return NextResponse.json(
      { ran: true, ms: Date.now() - started, ...done },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json(
      { ran: false, reason: e instanceof Error ? e.message.slice(0, 120) : "cycle failed" },
      { status: 503 },
    );
  } finally {
    runningSince = 0;
    lastRunAt = Date.now();
  }
}
