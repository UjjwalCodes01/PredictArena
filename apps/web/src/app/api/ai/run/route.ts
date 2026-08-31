import { NextResponse } from "next/server";
import { getSyncState, setSyncState } from "@predictarena/db";
import { runAgent, isConfigured } from "@predictarena/ai";
import { parseAmount } from "@predictarena/dex";
import { serverDb, aiDex, dbRead, withDeadline } from "@/lib/server";
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
      { ran: false, reason: "no API key" },
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

  // Global gate. If this read fails we do NOT run: without it there is no
  // throttle at all, and an unthrottled spender is worse than a stale one.
  let sinceMs: number;
  try {
    const row = await dbRead(() => getSyncState(db, LAST_RUN_KEY));
    const cursor = (row as { cursor?: string } | null)?.cursor;
    sinceMs = cursor ? Date.now() - new Date(cursor).getTime() : Number.MAX_SAFE_INTEGER;
  } catch {
    return NextResponse.json({ ran: false, reason: "gate unreadable" }, { status: 503 });
  }

  if (sinceMs < MIN_GAP_MS) {
    return NextResponse.json(
      { ran: false, reason: "throttled", nextInSec: Math.ceil((MIN_GAP_MS - sinceMs) / 1000) },
      { headers: { "cache-control": "no-store" } },
    );
  }

  runningSince = Date.now();
  const started = Date.now();

  // Claim the slot BEFORE working. A run that crashes must still hold the gate
  // shut, otherwise a failing forecaster retries on every single page view.
  try {
    await setSyncState(db, LAST_RUN_KEY, { cursor: new Date().toISOString() });
  } catch {
    runningSince = 0;
    return NextResponse.json({ ran: false, reason: "gate unwritable" }, { status: 503 });
  }

  try {
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
