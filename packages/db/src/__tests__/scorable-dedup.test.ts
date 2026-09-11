/**
 * The SQL pre-filter in `getScorableCalls` must be invisible to scoring.
 *
 * `computeStandings` already throws most of a week's calls away: it ignores
 * anything not settled, and keeps only the EARLIEST call per (wallet, window)
 * so a player cannot call both directions and bank whichever settles well.
 * Doing that discarding in Postgres rather than in Node is what keeps the
 * leaderboard under the Neon HTTP driver's 64MB response ceiling -- measured
 * on live data: 270,012 rows for one week, of which 34,267 survive the rule.
 *
 * That swap is only safe if both sides select the SAME row. This file pins the
 * equivalence, including the two cases live data actually contains: a wallet
 * holding both directions on one window (9,437 pairs in the measured week) and
 * two calls landing inside the same second (1,801 pairs).
 */
import { describe, it, expect } from "vitest";
import { computeStandings } from "../scoring";
import type { CallStatus, ScorableCall, Standing } from "../types";

const WEEK = "2026-W37";

/** Exactly the statuses the SQL `status IN (...)` clause keeps. */
const SCORABLE = new Set<CallStatus>(["WON", "LOST", "VOID"]);

/**
 * The rule `getScorableCalls` hands to Postgres:
 *
 *   WHERE week_id = $1 AND status IN ('WON','LOST','VOID')
 *   DISTINCT ON (wallet, window_id)
 *   ORDER BY wallet, window_id, date_trunc('second', placed_at), id
 *
 * `placedAtSec` is floored to whole seconds, which is what `date_trunc` does,
 * and the database collates in C order -- byte order, the same comparison
 * JavaScript makes on these ASCII ids. So this is a faithful mirror.
 */
function prefilter(rows: readonly ScorableCall[], weekId = WEEK): ScorableCall[] {
  const best = new Map<string, ScorableCall>();
  for (const r of rows) {
    if (r.weekId !== weekId || !SCORABLE.has(r.status)) continue;
    const key = `${r.wallet} ${r.windowId}`;
    const held = best.get(key);
    if (
      !held ||
      r.placedAtSec < held.placedAtSec ||
      (r.placedAtSec === held.placedAtSec && r.id < held.id)
    ) {
      best.set(key, r);
    }
  }
  return [...best.values()];
}

let seq = 0;
function call(over: Partial<ScorableCall> & { wallet: string; status: CallStatus }): ScorableCall {
  seq += 1;
  const placedAtSec = over.placedAtSec ?? 1_700_000_000 + seq * 60;
  return {
    id: over.id ?? `c${String(seq).padStart(4, "0")}`,
    wallet: over.wallet,
    windowId: over.windowId ?? `w${seq}`,
    direction: over.direction ?? "UP",
    status: over.status,
    placedAtSec,
    closesAtSec: over.closesAtSec ?? placedAtSec + 300,
    weekId: over.weekId ?? WEEK,
    // Even money unless a test says otherwise: 1 tUSDC for 2 contracts is 0.50.
    stake: over.stake ?? 1_000_000n,
    quantity: over.quantity ?? 2_000_000n,
  };
}

/** Standings are identical whether the pre-filter ran or not. */
function assertEquivalent(rows: readonly ScorableCall[]): Standing[] {
  const full = computeStandings(rows, WEEK);
  const filtered = computeStandings(prefilter(rows), WEEK);
  expect(filtered).toEqual(full);
  return full;
}

describe("getScorableCalls pre-filter equivalence", () => {
  it("drops statuses that never score, changing nothing", () => {
    const rows = [
      call({ wallet: "0xa", status: "WON" }),
      call({ wallet: "0xa", status: "LOST" }),
      call({ wallet: "0xa", status: "PENDING" }),
      call({ wallet: "0xa", status: "FAILED" }),
      call({ wallet: "0xb", status: "PENDING" }),
    ];
    const standings = assertEquivalent(rows);
    // The PENDING-only wallet never appears either way.
    expect(standings.map((s) => s.wallet)).toEqual(["0xa"]);
    expect(prefilter(rows)).toHaveLength(2);
  });

  it("keeps the earliest call when a wallet holds BOTH directions on one window", () => {
    // The farming case: back both sides, keep the winner. The rule says the
    // first call is the one that counts, so this must score as a LOSS.
    const rows = [
      call({ wallet: "0xa", status: "LOST", windowId: "w1", direction: "UP", placedAtSec: 1_000, id: "c1" }),
      call({ wallet: "0xa", status: "WON", windowId: "w1", direction: "DOWN", placedAtSec: 1_050, id: "c2" }),
    ];
    const standings = assertEquivalent(rows);
    expect(standings[0]?.wins).toBe(0);
    expect(standings[0]?.losses).toBe(1);
    expect(prefilter(rows).map((r) => r.id)).toEqual(["c1"]);
  });

  it("breaks a same-second tie by id, identically on both sides", () => {
    // Two calls inside one second: `placedAtSec` cannot separate them, so the
    // lower id wins. Declared out of order so a stable sort cannot fake it.
    const rows = [
      call({ wallet: "0xa", status: "WON", windowId: "w1", direction: "DOWN", placedAtSec: 2_000, id: "c9" }),
      call({ wallet: "0xa", status: "LOST", windowId: "w1", direction: "UP", placedAtSec: 2_000, id: "c3" }),
    ];
    const standings = assertEquivalent(rows);
    expect(prefilter(rows).map((r) => r.id)).toEqual(["c3"]);
    expect(standings[0]?.losses).toBe(1);
  });

  it("survives a mixed week of streaks, voids and real prices", () => {
    const rows = [
      // 0xa: three straight wins, so the third earns the x1.5 multiplier.
      call({ wallet: "0xa", status: "WON", windowId: "w1", closesAtSec: 100, stake: 600_000n, quantity: 1_000_000n }),
      call({ wallet: "0xa", status: "WON", windowId: "w2", closesAtSec: 200, stake: 550_000n, quantity: 1_000_000n }),
      call({ wallet: "0xa", status: "WON", windowId: "w3", closesAtSec: 300, stake: 700_000n, quantity: 1_000_000n }),
      // ...plus a LATER duplicate on w2 that must never be counted.
      call({ wallet: "0xa", status: "LOST", windowId: "w2", closesAtSec: 200, placedAtSec: 1_900_000_000 }),
      // 0xb: a void between two wins must not break the streak.
      call({ wallet: "0xb", status: "WON", windowId: "w4", closesAtSec: 100 }),
      call({ wallet: "0xb", status: "VOID", windowId: "w5", closesAtSec: 200 }),
      call({ wallet: "0xb", status: "WON", windowId: "w6", closesAtSec: 300 }),
      // 0xc: settled but noisy, with unscored rows interleaved.
      call({ wallet: "0xc", status: "LOST", windowId: "w7", closesAtSec: 100 }),
      call({ wallet: "0xc", status: "PENDING", windowId: "w8", closesAtSec: 200 }),
      call({ wallet: "0xc", status: "FAILED", windowId: "w9", closesAtSec: 300 }),
    ];
    const standings = assertEquivalent(rows);
    expect(standings.find((s) => s.wallet === "0xa")?.wins).toBe(3);
    expect(standings.find((s) => s.wallet === "0xb")?.currentStreak).toBe(2);
    expect(standings.find((s) => s.wallet === "0xc")?.losses).toBe(1);
  });

  it("does not depend on the order rows arrive in", () => {
    // Postgres returns DISTINCT ON rows ordered by (wallet, window_id); the
    // unfiltered path has no order at all. Neither may change the result.
    const rows = [
      call({ wallet: "0xb", status: "WON", windowId: "w2", closesAtSec: 200 }),
      call({ wallet: "0xa", status: "LOST", windowId: "w1", closesAtSec: 100 }),
      call({ wallet: "0xa", status: "WON", windowId: "w3", closesAtSec: 300 }),
      call({ wallet: "0xb", status: "VOID", windowId: "w4", closesAtSec: 400 }),
    ];
    const forward = computeStandings(prefilter(rows), WEEK);
    const reversed = computeStandings(prefilter([...rows].reverse()), WEEK);
    expect(reversed).toEqual(forward);
    expect(forward).toEqual(computeStandings(rows, WEEK));
  });

  it("ignores calls belonging to another week, as the WHERE clause does", () => {
    const rows = [
      call({ wallet: "0xa", status: "WON", windowId: "w1" }),
      call({ wallet: "0xa", status: "WON", windowId: "w2", weekId: "2026-W36" }),
    ];
    const standings = assertEquivalent(rows);
    expect(standings[0]?.wins).toBe(1);
  });
});
