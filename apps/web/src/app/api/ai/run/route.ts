import { NextResponse } from "next/server";
import { getSyncState, acquireLease } from "@predictarena/db";
import { runAgent, isConfigured } from "@predictarena/ai";
import { parseAmount } from "@predictarena/dex";
import { serverDb, aiDex, dbRead, withDeadline, ensureLiveNetwork } from "@/lib/server";
import { rateLimit, clientKey, tooManyRequests } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * One pass of the AI forecaster, driven by ordinary traffic.
 *
 * Same reasoning as `/api/tick`: there is nowhere free and reliable to run a
 * daemon, so the site does its own work while someone is looking at it. The
 * difference is that this endpoint SPENDS — API tokens, and testnet collateral
 * — so it is throttled harder and the throttle is global rather than
 * per-instance.
 *
 * The gate lives in `sync_state`, not in a module variable. A serverless
 * deployment runs many instances and each would carry its own lock, so a
 * per-instance guard would let the forecaster trade N times as often as
 * intended for no better reason than that traffic was spread around.
 */

/** Global floor between runs. A 5-minute series does not need more. */
const MIN_GAP_MS = 150_000;

/** Per instance, on top of the global gate: stops one page from stacking runs. */
let runningSince = 0;
const LOCK_LEASE_MS = 55_000;

const LAST_RUN_KEY = "ai:lastRun";

export async function GET(request: Request): Promise<NextResponse> {
  const limit = rateLimit(`ai:${clientKey(request)}`, { capacity: 4, refillPerSec: 0.05 });
  if (!limit.ok) return tooManyRequests(limit) as never;

  if (!isConfigured()) {
    return NextResponse.json(
      { ran: false, reason: "no model provider configured" },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const ai = aiDex();
  if (!ai) {
    return NextResponse.json(
      { ran: false, reason: "no wallet" },
      { headers: { "cache-control": "no-store" } },
    );
  }

  if (runningSince > 0 && Date.now() - runningSince < LOCK_LEASE_MS) {
    return NextResponse.json({ ran: false, reason: "already running" }, { headers: { "cache-control": "no-store" } });
  }

  const db = serverDb();

  /*
   * ONE atomic statement claims the slot, and claiming IS the throttle.
   *
   * The earlier version read the last-run time and then wrote its own — and
   * between that read and write, a second instance could do the same, so two
   * concurrent page views made the forecaster spend twice: model tokens and
   * testnet collateral, doubled by nothing but load-balancer routing. The
   * lease's INSERT … ON CONFLICT DO UPDATE … WHERE expired runs under a row
   * lock, so of N simultaneous callers exactly one gets the slot.
   *
   * Claimed BEFORE working, same as before: a run that crashes holds the gate
   * shut for the full gap rather than retrying on every page view. If the
   * claim itself fails, we do NOT run — an unthrottled spender is worse than
   * a stale one.
   */
  let claimed: boolean;
  try {
    claimed = await acquireLease(db, LAST_RUN_KEY, MIN_GAP_MS);
  } catch {
    return NextResponse.json({ ran: false, reason: "gate unreachable" }, { status: 503 });
  }

  if (!claimed) {
    let nextInSec: number | undefined;
    try {
      const row = await dbRead(() => getSyncState(db, LAST_RUN_KEY));
      const cursor = (row as { cursor?: string } | null)?.cursor;
      if (cursor) {
        const sinceMs = Date.now() - new Date(cursor).getTime();
        nextInSec = Math.max(0, Math.ceil((MIN_GAP_MS - sinceMs) / 1000));
      }
    } catch {
      // Purely informational; the denial stands either way.
    }
    return NextResponse.json(
      { ran: false, reason: "throttled", ...(nextInSec !== undefined ? { nextInSec } : {}) },
      { headers: { "cache-control": "no-store" } },
    );
  }

  runningSince = Date.now();
  const started = Date.now();

  try {
    // This is the one server-side path that SPENDS, so it does not get the
    // read path's leniency: chain id and collateral identity must be verified
    // before an order can be built. Cached after the first success, so the
    // cost is three RPC reads once per process, not per run.
    await ensureLiveNetwork(ai.dex);

    const decimals = ai.dex.collateral.decimals;
    const stake = parseAmount(process.env["AI_STAKE_TUSDC"] ?? "1", decimals);

    const run = await withDeadline("agent", 50_000, () =>
      runAgent({
        dex: ai.dex,
        db,
        wallet: ai.wallet,
        stake,
        assets: ["BTC", "ETH"],
      }),
    );

    return NextResponse.json(
      { ran: true, ms: Date.now() - started, ...run },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json(
      { ran: false, reason: e instanceof Error ? e.message.slice(0, 120) : "run failed" },
      { status: 503 },
    );
  } finally {
    runningSince = 0;
  }
}
