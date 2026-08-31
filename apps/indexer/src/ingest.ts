/**
 * Window ingestion: mirror live Up/Down windows into the projection.
 *
 * Writes are idempotent upserts, so this is safe to run every cycle and safe to
 * replay after a crash. The chain's values always overwrite ours -- the DB
 * never argues with it.
 */
import { getWindows, MarketStatus, type DexClient } from "@predictarena/dex";
import { upsertWindows, weekIdForClose, type Database, type NewWindowRow } from "@predictarena/db";
import { log } from "./log";

/** Map the on-chain numeric status onto the row enum we store. */
function windowStatusFor(onchainStatus: number, isResolved: boolean, isVoided: boolean): NewWindowRow["status"] {
  if (isVoided) return "VOIDED";
  if (isResolved) return "RESOLVED";
  if (onchainStatus === MarketStatus.Locked) return "LOCKED";
  return "OPEN";
}

import type { IngestTarget } from "./ingest-calls";

export type IngestedWindow = IngestTarget;

export interface IngestResult {
  seen: number;
  written: number;
  /** Handed to call ingestion so it does not re-query what we just read. */
  windows: IngestedWindow[];
}

/**
 * Pull every live window (tradable or not) and upsert it.
 *
 * `includeUntradable` matters: a window that has just locked is exactly the one
 * whose settlement we are about to need, so dropping it here would hide it.
 */
export async function ingestWindows(dex: DexClient, db: Database, assets?: readonly string[]): Promise<IngestResult> {
  const targets = assets && assets.length > 0 ? assets : [undefined];
  let seen = 0;
  let written = 0;
  const ingested: IngestedWindow[] = [];
  const rows: NewWindowRow[] = [];

  for (const asset of targets) {
    const windows = await getWindows(dex, {
      ...(asset ? { asset } : {}),
      includeUntradable: true,
      limit: 100,
    });
    seen += windows.length;

    for (const w of windows) {
      const closesAt = new Date(w.closesAtSec * 1000);
      const row: NewWindowRow = {
        id: w.marketId,
        asset: w.asset,
        venueId: w.venueId,
        // Kept so this window's fills stay readable after the venue stops
        // listing it -- see the catch-up sweep in ingest-calls.
        pool: w.pool,
        intervalSec: w.intervalSec,
        strike: w.strike,
        opensAt: new Date(w.opensAtSec * 1000),
        closesAt,
        status: windowStatusFor(w.status, w.onchain.isResolved, w.onchain.isVoided),
        winningOutcome: w.onchain.isResolved ? w.onchain.winningOutcome : null,
        resolvedAt: w.onchain.isResolved || w.onchain.isVoided ? new Date() : null,
        // Decided once, from the CLOSE time -- the league boundary the UI states.
        weekId: weekIdForClose(w.closesAtSec),
      };
      rows.push(row);
      ingested.push({
        marketId: w.marketId, pool: w.pool, asset: w.asset, closesAtSec: w.closesAtSec,
        resolved: w.onchain.isResolved, voided: w.onchain.isVoided, winningOutcome: w.onchain.winningOutcome,
      });
    }
  }

  // One statement rather than one per window. Writing them individually cost a
  // round trip each -- about six seconds for a normal pass, which is what
  // pushed the serverless ingest leg past its deadline.
  written = await upsertWindows(db, rows);

  log.debug({ seen, written }, "ingested windows");
  return { seen, written, windows: ingested };
}
