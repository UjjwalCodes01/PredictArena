import { NextResponse } from "next/server";
import { getSyncState, setSyncState, acquireLease } from "@predictarena/db";
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
const STALE_AFTER_MS = 60_000;

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
const LOCK_LEASE_MS = 45_000;

/** Cheap guard against re-running the instant a cycle finishes. */
let lastRunAt = 0;
const MIN_GAP_MS = 20_000;

/** Which leg to run next. Rotates so every leg comes round. */
let tickCount = 0;

/**
 * Where the next `calls` pass starts.
 *
 * Reading fills costs ~1.6s per window; scanning all 25 took over 25s and the
 * leg timed out having written nothing. Each pass takes a slice and advances,
 * so successive pokes cover everything and none of them overruns.
 */
let callsOffset = 0;
const CALLS_SLICE = 6;
const CATCHUP_SLICE = 4;

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

  // The module guards above are only a fast path: each serverless instance
  // carries its own copy, so under horizontal scale two instances could both
  // pass them and run the same leg concurrently. The work is idempotent, so
  // that was waste rather than corruption — but chain reads and an ocean-away
  // database make the waste real. This claim is one atomic statement shared by
  // every instance; whoever loses it simply reports that someone else is on it.
  try {
    if (!(await acquireLease(db, "tick:lease", MIN_GAP_MS))) {
      return NextResponse.json(
        { ran: false, reason: "another instance is on it" },
        { headers: { "cache-control": "no-store" } },
      );
    }
  } catch {
    return NextResponse.json({ ran: false, reason: "database unreachable" }, { status: 503 });
  }

  runningSince = Date.now();
  const started = Date.now();

  /*
   * ONE slice per invocation, rotating.
   *
   * A full cycle does not fit in a serverless function: `ingestWindows` alone
   * measured 15.3s for 23 windows (each row is an upsert round-trip to a
   * database an ocean away), and the complete cycle ran past 115s locally.
   * Trying to do it all produced FUNCTION_INVOCATION_TIMEOUT — a 504, no work
   * done, nothing to show for the invocation.
   *
   * So each poke does one leg and finishes well inside the limit. The browser
   * pokes every 90 seconds, so all three legs come round within a few minutes,
   * and every invocation actually completes instead of being killed.
   *
   * Order matters: settlement first, because a call stuck on PENDING is the
   * most visible failure; then new calls; then the catch-up safety net.
   */
  const LEGS = ["settle", "windows", "calls", "catchup"] as const;
  const leg = LEGS[tickCount % LEGS.length]!;
  tickCount += 1;

  const done: Record<string, number> = {};
  try {
    const dex = serverDex();

    if (leg === "settle") {
      const r = await withDeadline("reconcile", 20_000, () => reconcile(dex, db, "overdue"));
      done["settled"] = r.callsSettled;
    } else if (leg === "windows") {
      const w = await withDeadline("ingestWindows", 25_000, () =>
        ingestWindows(dex, db, ["BTC", "ETH"]),
      );
      done["windows"] = w.written;
    } else if (leg === "calls") {
      // Its OWN leg, and a SLICE of it. Bundled onto the windows pass, calls
      // never ran at all; scanning every window at once, it timed out at 25s.
      // Reading fills costs ~1.6s per window, so six per pass fits and the
      // offset walks through the rest over successive pokes.
      const w = await withDeadline("windowsForCalls", 18_000, () =>
        ingestWindows(dex, db, ["BTC", "ETH"]),
      );
      const all = w.windows;
      if (all.length > 0) {
        const startAt = callsOffset % all.length;
        const slice = [...all, ...all].slice(startAt, startAt + CALLS_SLICE);
        callsOffset = (startAt + CALLS_SLICE) % all.length;
        const c = await withDeadline("ingestCalls", 22_000, () => ingestCalls(dex, db, slice));
        done["calls"] = c.callsWritten;
        done["scanned"] = slice.length;
      }
    } else {
      const c = await withDeadline("catchUp", 22_000, () =>
        catchUpClosedWindows(dex, db, 60, CATCHUP_SLICE),
      );
      done["recovered"] = c.callsWritten;
    }

    // Heartbeat every time: the point is that SOMETHING is watching.
    const now = new Date().toISOString();
    await setSyncState(db, "heartbeat", { cursor: now });
    if (leg === "calls") await setSyncState(db, "ingest", { cursor: now });

    return NextResponse.json(
      { ran: true, leg, ms: Date.now() - started, ...done },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json(
      { ran: false, leg, reason: e instanceof Error ? e.message.slice(0, 120) : "cycle failed" },
      { status: 503 },
    );
  } finally {
    runningSince = 0;
    lastRunAt = Date.now();
  }
}
