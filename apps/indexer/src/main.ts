/**
 * `pnpm indexer` -- keeps the DB projection in step with chain truth.
 *
 * Two loops, deliberately independent:
 *
 *   ingest      every 20s   mirror live windows into the projection
 *   reconcile   every 45s   settle any call whose window has closed
 *
 * Reconciliation is the GUARANTEE (AGENTS.md section 5). A live feed is only
 * ever an optimisation, so nothing here depends on a socket staying up: if this
 * process is killed mid-flight and restarted, the startup pass re-checks every
 * non-terminal call and the settlement lands anyway. That is the Phase 2 exit
 * gate, and it is a property of polling, not of careful shutdown handling.
 */
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import {
  assertLiveNetwork, createDexClient, DexError, type DexClient,
} from "@predictarena/dex";
import { createDb, setSyncState, currentWeekId, getStandings, type Database } from "@predictarena/db";
import { log } from "./log.js";
import { ingestWindows } from "./ingest.js";
import { ingestCalls } from "./ingest-calls.js";
import { reconcile } from "./reconcile.js";
import { startLiveTail } from "./live.js";

// One .env at the repo root; this app lives two levels down.
loadDotenv({ path: resolve(import.meta.dirname, "..", "..", "..", ".env"), quiet: true });

const INGEST_MS = Number(process.env["INGEST_INTERVAL_MS"] ?? 20_000);
const RECONCILE_MS = Number(process.env["RECONCILE_INTERVAL_MS"] ?? 45_000);
const ASSETS = (process.env["INDEX_ASSETS"] ?? "BTC,ETH").split(",").map((a) => a.trim()).filter(Boolean);
/** The tail is an optimisation; turning it off must never break correctness. */
const LIVE_TAIL = process.env["LIVE_TAIL"] !== "0";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Runs `fn` forever on an interval, surviving individual failures. */
function loop(name: string, everyMs: number, fn: () => Promise<void>, stopped: () => boolean): Promise<void> {
  return (async () => {
    while (!stopped()) {
      const started = Date.now();
      try {
        await fn();
      } catch (e) {
        // One bad cycle must never kill the loop -- that is how a projection
        // silently stops updating.
        const err = e instanceof DexError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
        log.error({ loop: name, err }, "cycle failed");
      }
      const elapsed = Date.now() - started;
      await sleep(Math.max(1_000, everyMs - elapsed));
    }
  })();
}

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  if (!databaseUrl) {
    log.error(
      { action: "Add your Neon connection string to .env as DATABASE_URL, then run `pnpm db:migrate`." },
      "DATABASE_URL is not set",
    );
    process.exit(1);
  }

  const db: Database = createDb(databaseUrl);
  const dex: DexClient = createDexClient({
    indexerUrl: process.env["INDEXER_URL"] ?? "https://dev.smk.somnia.host/v1/graphql",
    rpcHttpUrl: process.env["RPC_HTTP_URL"] ?? "https://dream-rpc.somnia.network",
    rpcWsUrl: process.env["RPC_WS_URL"] ?? "wss://dream-rpc.somnia.network/ws",
  });

  const net = await assertLiveNetwork(dex);
  log.info({ chainId: net.chainId, collateral: net.collateralSymbol, assets: ASSETS }, "indexer starting");

  // Startup pass: re-check EVERY non-terminal call, not just the overdue ones.
  // This is what closes the gap for however long the process was down.
  const startup = await reconcile(dex, db, "all");
  log.info({ ...startup }, "startup reconciliation complete");

  // The live tail only ever ASKS for an early reconcile; it never writes. If it
  // never connects, everything below still works on the 45s timer.
  let tail: ReturnType<typeof startLiveTail> | null = null;
  let reconcileInFlight = false;
  const nudgeReconcile = (reason: string): void => {
    if (stopped || reconcileInFlight) return;
    reconcileInFlight = true;
    void reconcile(dex, db, "overdue")
      .then((r) => {
        if (r.callsSettled > 0) log.info({ ...r, reason }, "early reconcile from live tail");
      })
      .catch((e: unknown) => log.warn({ reason, err: e instanceof Error ? e.message : String(e) }, "early reconcile failed"))
      .finally(() => { reconcileInFlight = false; });
  };

  let stopped = false;
  const stop = (signal: string): void => {
    if (stopped) return;
    stopped = true;
    log.info({ signal }, "shutting down");
    tail?.stop();
    // No draining needed: every write is an idempotent upsert, so whatever was
    // in flight is simply redone on the next start.
    dex.close();
    setTimeout(() => process.exit(0), 200);
  };
  tail = LIVE_TAIL
    ? startLiveTail(dex, {
        onChange: () => nudgeReconcile("live-change"),
        onReconnect: () => nudgeReconcile("reconnect-gap"),
      })
    : null;
  if (!LIVE_TAIL) log.info("live tail disabled (LIVE_TAIL=0); polling still guarantees correctness");

  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  await Promise.all([
    loop("ingest", INGEST_MS, async () => {
      const w = await ingestWindows(dex, db, ASSETS);
      // Calls are derived from chain fills, never from anything a client posts.
      const c = await ingestCalls(dex, db, w.windows);
      await setSyncState(db, "ingest", { cursor: new Date().toISOString() });
      log.info(
        { windows: w.written, fills: c.fillsSeen, calls: c.callsWritten, errors: c.errors },
        "ingest cycle",
      );
    }, () => stopped),

    loop("reconcile", RECONCILE_MS, async () => {
      const r = await reconcile(dex, db, "overdue");
      await setSyncState(db, "reconcile", { cursor: new Date().toISOString() });
      if (r.checked > 0 || r.callsSettled > 0) log.info({ ...r }, "reconcile cycle");
      else log.debug({ ...r }, "reconcile cycle (nothing pending)");
    }, () => stopped),

    // Heartbeat doubles as a liveness row: a dead indexer must be visible in
    // the DB within a minute, not discovered at demo time.
    loop("heartbeat", 30_000, async () => {
      await setSyncState(db, "heartbeat", { cursor: new Date().toISOString() });
      const standings = await getStandings(db, currentWeekId());
      log.debug({ week: currentWeekId(), players: standings.length }, "heartbeat");
    }, () => stopped),
  ]);
}

void main().catch((e: unknown) => {
  log.fatal({ err: e instanceof Error ? e.message : String(e) }, "indexer failed to start");
  process.exit(1);
});
