import { NextResponse } from "next/server";
import { setSyncState } from "@predictarena/db";
import { ingestWindows } from "../../../../../../indexer/src/ingest";
import { ingestCalls, catchUpClosedWindows } from "../../../../../../indexer/src/ingest-calls";
import { reconcile } from "../../../../../../indexer/src/reconcile";
import { serverDb, serverDex } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * One indexer cycle, on demand.
 *
 * The indexer is a daemon, and Vercel runs functions — so on a Vercel-only
 * deployment nothing keeps the projection up to date. The symptom is brutal and
 * silent: calls settle on-chain, the leaderboard never moves, and a player who
 * just placed a call sees "no calls yet".
 *
 * This is the same work the daemon's loops do, exposed so ANY scheduler can
 * drive it — Vercel Cron, a GitHub Actions schedule, or cron-job.org. Running
 * the real daemon is still better (it tails live events and reacts in seconds
 * rather than on a timer); this exists so a deployment without one is merely
 * slower rather than broken.
 *
 * Protected by a shared secret. Without it, anyone could force unbounded chain
 * and database work by hitting a public URL.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const secret = process.env["CRON_SECRET"];
  if (!secret) {
    return NextResponse.json(
      {
        code: "NOT_CONFIGURED",
        message: "CRON_SECRET is not set, so this endpoint is disabled.",
        action: "Set CRON_SECRET in the deployment environment to enable scheduled ingestion.",
      },
      { status: 503 },
    );
  }

  // Vercel Cron sends the secret as a bearer token; other schedulers can use
  // the query parameter.
  const auth = request.headers.get("authorization");
  const { searchParams } = new URL(request.url);
  const provided = auth?.replace(/^Bearer\s+/i, "") ?? searchParams.get("key");
  if (provided !== secret) {
    return NextResponse.json({ code: "UNAUTHORIZED", message: "Bad or missing key." }, { status: 401 });
  }

  const started = Date.now();
  // Serverless functions are killed at a hard wall time, and a full cycle
  // measured over 140s locally — it would simply never finish. So the legs run
  // in priority order against a budget, and whatever does not fit is picked up
  // by the next run. Every leg is idempotent and re-scans from scratch, so a
  // partial cycle loses nothing.
  const BUDGET_MS = 45_000;
  const spent = (): number => Date.now() - started;
  const room = (need: number): boolean => spent() + need < BUDGET_MS;

  const done: Record<string, number> = {};
  const skipped: string[] = [];

  try {
    const dex = serverDex();
    const db = serverDb();

    // 1. Live windows and their calls. Without this nothing new is ever seen.
    const windows = await ingestWindows(dex, db, ["BTC", "ETH"]);
    done["windows"] = windows.written;

    if (room(15_000)) {
      const calls = await ingestCalls(dex, db, windows.windows);
      done["calls"] = calls.callsWritten;
    } else skipped.push("calls");

    // 2. Settlements. A call stuck on PENDING is the most visible failure.
    if (room(10_000)) {
      const settled = await reconcile(dex, db, "overdue");
      done["settled"] = settled.callsSettled;
    } else skipped.push("settled");

    // 3. Catch-up last: it is the safety net, and the most expensive leg.
    if (room(15_000)) {
      const caught = await catchUpClosedWindows(dex, db, 60);
      done["recovered"] = caught.callsWritten;
    } else skipped.push("recovered");

    await setSyncState(db, "ingest", { cursor: new Date().toISOString() });
    await setSyncState(db, "heartbeat", { cursor: new Date().toISOString() });

    return NextResponse.json(
      { ok: true, ms: spent(), ...done, ...(skipped.length ? { skipped } : {}) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        ms: spent(),
        message: e instanceof Error ? e.message : "Ingest cycle failed.",
      },
      { status: 503 },
    );
  }
}
