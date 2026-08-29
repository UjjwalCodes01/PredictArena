/**
 * Reconciliation -- the guarantee.
 *
 * A live feed can drop; a poll cannot silently stop being true. So every
 * non-terminal call is re-checked against the CHAIN on a timer and again on
 * every startup, which is what makes recovery from a crash a restart rather
 * than a repair.
 *
 * Nothing a client says is trusted here: a call's outcome is derived from the
 * window's on-chain settlement and the direction we recorded at placement.
 */
import { getSettlement, type DexClient } from "@predictarena/dex";
import {
  getOverdueCalls, getNonTerminalCalls, settleCallsForWindow, markWindowSettled,
  type Database,
} from "@predictarena/db";
import { log } from "./log.js";

export interface ReconcileResult {
  checked: number;
  windowsSettled: number;
  callsSettled: number;
  errors: number;
}

/**
 * Settle what is settle-able.
 *
 * `mode: "overdue"` is the steady-state pass: only calls whose window has
 * already closed. `mode: "all"` is the startup pass, which re-checks every
 * non-terminal call regardless, covering whatever happened while we were down.
 */
export async function reconcile(
  dex: DexClient,
  db: Database,
  mode: "overdue" | "all" = "overdue",
): Promise<ReconcileResult> {
  const now = new Date();
  const pending = mode === "all" ? await getNonTerminalCalls(db) : await getOverdueCalls(db, now);

  const result: ReconcileResult = { checked: pending.length, windowsSettled: 0, callsSettled: 0, errors: 0 };
  if (pending.length === 0) return result;

  // One chain read per window, not per call: many calls can share a window.
  const windowIds = [...new Set(pending.map((c) => c.windowId))];

  for (const windowId of windowIds) {
    try {
      const settlement = await getSettlement(dex, windowId as `0x${string}`);
      if (settlement.status === "PENDING") continue;

      const voided = settlement.status === "VOIDED";
      const settledAt = new Date();

      // UPDATE, never upsert: we know the id but not the asset or week, so an
      // insert here would fabricate a row with empty fields.
      const known = await markWindowSettled(db, {
        windowId,
        winningOutcome: settlement.winningOutcome,
        voided,
        resolvedAt: settledAt,
      });
      if (!known) {
        // The calls exist but their window was never ingested. Settle the calls
        // anyway (chain truth is chain truth) and say so loudly, because it
        // means ingestion missed something.
        log.warn({ windowId }, "settling calls for a window that was never ingested");
      }

      const n = await settleCallsForWindow(db, {
        windowId,
        winningOutcome: settlement.winningOutcome,
        voided,
        settledAt,
      });

      result.windowsSettled += 1;
      result.callsSettled += n;
      log.info(
        { windowId, outcome: voided ? "VOID" : settlement.winningDirection, callsSettled: n },
        "window settled",
      );
    } catch (e) {
      result.errors += 1;
      log.warn({ windowId, err: e instanceof Error ? e.message : String(e) }, "reconcile failed for window");
    }
  }

  return result;
}
