/**
 * Settlement must be able to CORRECT, not merely apply.
 *
 * The defect these pin: `settleCallsForWindow` filtered on `status = PENDING`,
 * which made every settlement permanent the moment it was written. A window
 * voided after resolving, or an outcome corrected upstream, could never reach
 * a row already marked WON or LOST — the projection would contradict the chain
 * forever, which is exactly what "the chain is the source of truth" forbids.
 *
 * There is no database here. The tests capture the SQL the query would run and
 * assert on its shape, because the shape IS the guarantee: which rows are in
 * scope, and which are protected.
 */
import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { settleCallsForWindow, upsertCalls, upsertCall, acquireLease } from "../queries";
import type { Database } from "../client";
import type { NewCallRow } from "../schema";

const dialect = new PgDialect();
const render = (q: SQL): { sql: string; params: unknown[] } => {
  const out = dialect.sqlToQuery(q);
  return { sql: out.sql.toLowerCase(), params: out.params };
};

/** A stub that records the UPDATE's pieces and reports two rows touched. */
function captureUpdate() {
  const captured: { set?: Record<string, unknown>; where?: SQL } = {};
  const db = {
    update: () => ({
      set: (s: Record<string, unknown>) => {
        captured.set = s;
        return {
          where: (w: SQL) => {
            captured.where = w;
            return { returning: () => Promise.resolve([{ id: "a" }, { id: "b" }]) };
          },
        };
      },
    }),
  } as unknown as Database;
  return { db, captured };
}

/** A stub that records the INSERT's conflict clause. */
function captureInsert() {
  const captured: { conflict?: { set: Record<string, unknown> } } = {};
  const db = {
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: (cfg: { set: Record<string, unknown> }) => {
          captured.conflict = cfg;
          return Promise.resolve();
        },
      }),
    }),
  } as unknown as Database;
  return { db, captured };
}

const base = { windowId: "0xwindow", settledAt: new Date("2026-09-01T00:00:00Z") };

describe("settleCallsForWindow — corrections reach settled rows", () => {
  it("no longer restricts the update to PENDING rows", async () => {
    const { db, captured } = captureUpdate();
    await settleCallsForWindow(db, { ...base, winningOutcome: 0, voided: false });
    const { sql, params } = render(captured.where!);
    // The old guard was `status = 'PENDING'`. Its absence is what lets a
    // WON → VOID or WON → LOST correction land.
    expect(params).not.toContain("PENDING");
    expect(sql).not.toMatch(/status" = /);
  });

  it("targets rows that DISAGREE with the chain, so replays are no-ops", async () => {
    const { db, captured } = captureUpdate();
    await settleCallsForWindow(db, { ...base, winningOutcome: 0, voided: false });
    expect(render(captured.where!).sql).toContain("is distinct from");
  });

  it("never resurrects a FAILED placement", async () => {
    // FAILED means the order never became a chain fill. No settlement can
    // retroactively make it real, so it must stay out of scope.
    const { db, captured } = captureUpdate();
    await settleCallsForWindow(db, { ...base, winningOutcome: 1, voided: false });
    const { sql, params } = render(captured.where!);
    expect(sql).toContain("<>");
    expect(params).toContain("FAILED");
  });

  it("a void overwrites every prior verdict with VOID", async () => {
    const { db, captured } = captureUpdate();
    const n = await settleCallsForWindow(db, { ...base, winningOutcome: null, voided: true });
    expect(render(captured.set!["status"] as SQL).sql).toContain("'void'::call_status");
    expect(n).toBe(2);
  });

  it("outcome 0 makes UP the winner in the derived CASE", async () => {
    const { db, captured } = captureUpdate();
    await settleCallsForWindow(db, { ...base, winningOutcome: 0, voided: false });
    const { params } = render(captured.set!["status"] as SQL);
    expect(params).toContain("UP");
  });

  it("outcome 1 makes DOWN the winner", async () => {
    const { db, captured } = captureUpdate();
    await settleCallsForWindow(db, { ...base, winningOutcome: 1, voided: false });
    expect(render(captured.set!["status"] as SQL).params).toContain("DOWN");
  });
});

const row: NewCallRow = {
  id: "0xtx:0xwindow:UP",
  wallet: "0xwallet",
  windowId: "0xwindow",
  asset: "BTC",
  direction: "UP",
  stake: "1000000",
  quantity: "2000000",
  txHash: "0xtx",
  status: "PENDING",
  placedAt: new Date("2026-09-01T00:00:00Z"),
  settledAt: null,
  weekId: "2026-W36",
};

describe("call upserts — a replay may correct every chain-derived column", () => {
  // If the venue's fill data was wrong the first time — a stake amended, a
  // timestamp corrected — re-ingesting must fix the row, or the projection
  // keeps the error forever and the standings computed from it stay wrong.
  const MUST_REFRESH = [
    "wallet", "stake", "quantity", "placedAt", "weekId", "asset",
    "status", "settledAt", "payout", "redeemTxHash",
  ];

  it("upsertCalls refreshes them all on conflict", async () => {
    const { db, captured } = captureInsert();
    await upsertCalls(db, [row]);
    for (const col of MUST_REFRESH) expect(captured.conflict!.set).toHaveProperty(col);
  });

  it("upsertCall (singular) refreshes them all too", async () => {
    const { db, captured } = captureInsert();
    await upsertCall(db, row);
    for (const col of MUST_REFRESH) expect(captured.conflict!.set).toHaveProperty(col);
  });

  it("weekId travels with placedAt", async () => {
    // weekId is derived from the close time; correcting the timestamp while
    // leaving the week behind would strand the call in a week it was not in.
    const { db, captured } = captureInsert();
    await upsertCalls(db, [row]);
    expect(captured.conflict!.set).toHaveProperty("weekId");
    expect(captured.conflict!.set).toHaveProperty("placedAt");
  });
});

describe("acquireLease — one claim per TTL, atomically", () => {
  function leaseDb(returned: Array<{ key: string }>) {
    const captured: { cfg?: { setWhere?: SQL } } = {};
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: (cfg: { setWhere?: SQL }) => {
            captured.cfg = cfg;
            return { returning: () => Promise.resolve(returned) };
          },
        }),
      }),
    } as unknown as Database;
    return { db, captured };
  }

  it("grants when the row comes back", async () => {
    const { db } = leaseDb([{ key: "lease:x" }]);
    expect(await acquireLease(db, "lease:x", 20_000)).toBe(true);
  });

  it("denies when someone else holds it — no row returned", async () => {
    const { db } = leaseDb([]);
    expect(await acquireLease(db, "lease:x", 20_000)).toBe(false);
  });

  it("guards the update with an expiry, so the claim is one atomic statement", async () => {
    // The whole point: no separate read-then-write window in which two
    // instances both see "stale" and both spend.
    const { db, captured } = leaseDb([]);
    await acquireLease(db, "lease:x", 20_000);
    expect(captured.cfg?.setWhere).toBeDefined();
    expect(render(captured.cfg!.setWhere!).sql).toContain('"updated_at" <');
  });
});
