/**
 * Scoring. Test-first per CLAUDE.md, table-driven, and every rule in
 * docs/phase2-design.md is pinned here so a decision cannot silently drift.
 *
 * Points are DERIVED data: these tests are the specification, and the engine
 * must be recomputable and idempotent from raw calls alone.
 */
import { describe, it, expect } from "vitest";
import { computeStandings, streakMultiplierX10, pointsForWin } from "../scoring";
import { POINTS_PER_WIN, type CallStatus, type ScorableCall } from "../types";

const WEEK = "2026-W35";
let seq = 0;

/** Terse call builder — closes are spaced so ordering is unambiguous. */
function call(wallet: string, status: CallStatus, over: Partial<ScorableCall> = {}): ScorableCall {
  seq += 1;
  return {
    id: `c${seq}`,
    wallet,
    windowId: over.windowId ?? `w${seq}`,
    direction: "UP",
    status,
    placedAtSec: over.placedAtSec ?? 1_000_000 + seq * 100,
    closesAtSec: over.closesAtSec ?? 1_000_000 + seq * 100 + 60,
    weekId: over.weekId ?? WEEK,
    ...over,
  };
}

const only = (calls: ScorableCall[], wallet = "0xA") =>
  computeStandings(calls, WEEK).find((s) => s.wallet === wallet)!;

describe("streak multiplier", () => {
  const cases: Array<[number, number, string]> = [
    [1, 10, "first win is x1"],
    [2, 10, "second win still x1"],
    [3, 15, "third win earns x1.5 — the win that reaches 3 is the one that gets it"],
    [4, 15, "fourth stays x1.5"],
    [5, 20, "fifth reaches x2"],
    [9, 20, "capped at x2"],
    [50, 20, "still capped"],
  ];
  for (const [streak, wantX10, label] of cases) {
    it(`${label}: streak ${streak} -> x${wantX10 / 10}`, () => {
      expect(streakMultiplierX10(streak)).toBe(wantX10);
    });
  }

  it("produces only whole points — no float ever enters scoring", () => {
    for (let s = 1; s <= 12; s += 1) {
      const p = pointsForWin(s);
      expect(Number.isInteger(p)).toBe(true);
    }
    expect(pointsForWin(1)).toBe(10);
    expect(pointsForWin(3)).toBe(15);
    expect(pointsForWin(5)).toBe(20);
  });
});

describe("streaks", () => {
  it("builds across consecutive wins: 10+10+15+15+20 = 70", () => {
    const calls = Array.from({ length: 5 }, () => call("0xA", "WON"));
    const s = only(calls);
    expect(s.points).toBe(70);
    expect(s.currentStreak).toBe(5);
    expect(s.bestStreak).toBe(5);
  });

  it("a loss breaks the streak and the multiplier restarts", () => {
    const calls = [
      call("0xA", "WON"), call("0xA", "WON"), call("0xA", "WON"), // 10+10+15 = 35
      call("0xA", "LOST"),                                        // breaks
      call("0xA", "WON"),                                         // back to x1 -> 10
    ];
    const s = only(calls);
    expect(s.points).toBe(45);
    expect(s.currentStreak).toBe(1);
    expect(s.bestStreak).toBe(3);
  });

  it("a VOID mid-streak preserves it and scores nothing", () => {
    const calls = [
      call("0xA", "WON"), call("0xA", "WON"),   // 10+10
      call("0xA", "VOID"),                      // 0 points, streak survives
      call("0xA", "WON"),                       // third consecutive win -> 15
    ];
    const s = only(calls);
    expect(s.points).toBe(35);
    expect(s.currentStreak).toBe(3);
    expect(s.voids).toBe(1);
  });

  it("orders by window CLOSE time, not placement", () => {
    // Placed out of order; closes define the sequence.
    const later = call("0xA", "LOST", { placedAtSec: 1, closesAtSec: 9_000 });
    const earlier = call("0xA", "WON", { placedAtSec: 9_000, closesAtSec: 1_000 });
    const s = only([later, earlier]);
    // Win closes first, then the loss breaks it.
    expect(s.currentStreak).toBe(0);
    expect(s.bestStreak).toBe(1);
    expect(s.points).toBe(10);
  });
});

describe("non-settled calls", () => {
  it("PENDING and FAILED neither score, break a streak, nor count", () => {
    const calls = [
      call("0xA", "WON"), call("0xA", "WON"),
      call("0xA", "PENDING"), call("0xA", "FAILED"),
      call("0xA", "WON"),
    ];
    const s = only(calls);
    expect(s.points).toBe(35);          // 10 + 10 + 15
    expect(s.currentStreak).toBe(3);
    expect(s.settled).toBe(3);
  });
});

describe("farming cap", () => {
  it("scores at most ONE call per wallet per window", () => {
    const calls = [
      call("0xA", "WON", { windowId: "w-same", placedAtSec: 100 }),
      call("0xA", "WON", { windowId: "w-same", placedAtSec: 200 }),
      call("0xA", "WON", { windowId: "w-same", placedAtSec: 300 }),
    ];
    const s = only(calls);
    expect(s.points).toBe(10);
    expect(s.wins).toBe(1);
    expect(s.settled).toBe(1);
  });

  it("keeps the EARLIEST call on that window, not the luckiest", () => {
    const calls = [
      call("0xA", "LOST", { windowId: "w-same", placedAtSec: 100 }),
      call("0xA", "WON", { windowId: "w-same", placedAtSec: 200 }),
    ];
    const s = only(calls);
    expect(s.wins).toBe(0);
    expect(s.losses).toBe(1);
    expect(s.points).toBe(0);
  });

  it("does not cap across DIFFERENT windows", () => {
    const calls = [
      call("0xA", "WON", { windowId: "w1" }),
      call("0xA", "WON", { windowId: "w2" }),
    ];
    expect(only(calls).points).toBe(20);
  });
});

describe("calibration", () => {
  it("is null below the 5-settled minimum", () => {
    const calls = Array.from({ length: 4 }, () => call("0xA", "WON"));
    expect(only(calls).calibration).toBeNull();
  });

  it("appears at exactly 5 settled calls", () => {
    const calls = Array.from({ length: 5 }, () => call("0xA", "WON"));
    expect(only(calls).calibration).toBe(100);
  });

  it("EXCLUDES voids from the denominator", () => {
    // 3 wins, 2 losses, 3 voids -> 3/5 = 60%, not 3/8.
    const calls = [
      call("0xA", "WON"), call("0xA", "WON"), call("0xA", "WON"),
      call("0xA", "LOST"), call("0xA", "LOST"),
      call("0xA", "VOID"), call("0xA", "VOID"), call("0xA", "VOID"),
    ];
    const s = only(calls);
    expect(s.settled).toBe(5);
    expect(s.calibration).toBe(60);
  });

  it("rounds to one decimal", () => {
    // 2 wins of 6 settled = 33.333...%
    const calls = [
      call("0xA", "WON"), call("0xA", "WON"),
      call("0xA", "LOST"), call("0xA", "LOST"), call("0xA", "LOST"), call("0xA", "LOST"),
    ];
    expect(only(calls).calibration).toBe(33.3);
  });
});

describe("ranking and tie-breaks", () => {
  it("ranks by points descending", () => {
    const calls = [
      call("0xA", "WON"),
      call("0xB", "WON"), call("0xB", "WON"), call("0xB", "WON"),
    ];
    const standings = computeStandings(calls, WEEK);
    expect(standings.map((s) => s.wallet)).toEqual(["0xB", "0xA"]);
    expect(standings[0]!.rank).toBe(1);
    expect(standings[1]!.rank).toBe(2);
  });

  it("breaks a points tie on higher calibration", () => {
    // Both score 10. 0xA has 5 settled at 20%, 0xB has 5 settled at 20%... make them differ:
    // 0xA: 1 win + 4 losses = 20%. 0xB: 1 win + 9 losses = 10%.
    const calls = [
      call("0xA", "WON"), ...Array.from({ length: 4 }, () => call("0xA", "LOST")),
      call("0xB", "WON"), ...Array.from({ length: 9 }, () => call("0xB", "LOST")),
    ];
    const standings = computeStandings(calls, WEEK);
    expect(standings[0]!.points).toBe(standings[1]!.points);
    expect(standings[0]!.wallet).toBe("0xA");
  });

  it("then breaks on the EARLIER last win", () => {
    const calls = [
      call("0xA", "WON", { closesAtSec: 5_000 }),
      call("0xB", "WON", { closesAtSec: 1_000 }),
    ];
    const standings = computeStandings(calls, WEEK);
    expect(standings[0]!.wallet).toBe("0xB");
  });

  it("finally breaks on wallet address so the order is never random", () => {
    const calls = [call("0xB", "WON", { closesAtSec: 1_000 }), call("0xA", "WON", { closesAtSec: 1_000 })];
    const standings = computeStandings(calls, WEEK);
    expect(standings.map((s) => s.wallet)).toEqual(["0xA", "0xB"]);
  });
});

describe("week scoping", () => {
  it("ignores calls from other weeks entirely", () => {
    const calls = [
      call("0xA", "WON", { weekId: WEEK }),
      call("0xA", "WON", { weekId: "2026-W34" }),
      call("0xA", "WON", { weekId: "2026-W36" }),
    ];
    const s = only(calls);
    expect(s.points).toBe(10);
    expect(s.settled).toBe(1);
  });

  it("a streak cannot span the Monday reset", () => {
    const prev = Array.from({ length: 4 }, () => call("0xA", "WON", { weekId: "2026-W34" }));
    const now = [call("0xA", "WON", { weekId: WEEK })];
    // Within W35 this is the FIRST win, so x1 — not a continuation to x2.
    expect(only([...prev, ...now]).points).toBe(10);
  });
});

describe("determinism", () => {
  it("is idempotent — recomputing gives an identical result", () => {
    const calls = [
      call("0xA", "WON"), call("0xA", "VOID"), call("0xA", "WON"),
      call("0xB", "LOST"), call("0xB", "WON"),
    ];
    expect(computeStandings(calls, WEEK)).toEqual(computeStandings(calls, WEEK));
  });

  it("does not depend on input order", () => {
    const calls = [
      call("0xA", "WON"), call("0xA", "LOST"), call("0xA", "WON"),
      call("0xB", "WON"), call("0xB", "VOID"),
    ];
    const forward = computeStandings(calls, WEEK);
    const reversed = computeStandings([...calls].reverse(), WEEK);
    expect(reversed).toEqual(forward);
  });

  it("does not mutate its input", () => {
    const calls = [call("0xA", "WON"), call("0xA", "LOST")];
    const snapshot = JSON.parse(JSON.stringify(calls));
    computeStandings(calls, WEEK);
    expect(calls).toEqual(snapshot);
  });

  it("returns an empty leaderboard for no calls — a cold start is not an error", () => {
    expect(computeStandings([], WEEK)).toEqual([]);
  });

  it("omits wallets with no settled calls in the week", () => {
    const calls = [call("0xA", "PENDING"), call("0xB", "WON")];
    expect(computeStandings(calls, WEEK).map((s) => s.wallet)).toEqual(["0xB"]);
  });
});

describe("constants match the documented rules", () => {
  it("a win is worth 10 before the multiplier", () => {
    expect(POINTS_PER_WIN).toBe(10);
  });
});
