/**
 * Duel resolution.
 *
 * A duel is a view over calls, so these tests are really asking one question:
 * can any arrangement of calls produce a result that disagrees with the
 * leaderboard, or that a player could engineer in their favour?
 */
import { describe, it, expect } from "vitest";
import { resolveDuel, tallyDuels, type DuelInput } from "../duels.js";
import type { CallStatus, Direction } from "../types.js";

const A = "0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa";
const B = "0xBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbb";
const CLOSES = 1_000_000;

let seq = 0;
function c(
  wallet: string,
  status: CallStatus,
  over: Partial<{ direction: Direction; placedAtSec: number; id: string }> = {},
) {
  seq += 1;
  return {
    wallet,
    status,
    direction: over.direction ?? ("UP" as Direction),
    placedAtSec: over.placedAtSec ?? CLOSES - 100 + seq,
    id: over.id ?? `d${seq}`,
  };
}

const duel = (calls: DuelInput["calls"]): DuelInput => ({
  challenger: A,
  opponent: B,
  windowId: "w1",
  closesAtSec: CLOSES,
  calls,
});

const AFTER = CLOSES + 1;
const BEFORE = CLOSES - 1;

describe("while the window is open", () => {
  it("is OPEN when neither has called", () => {
    expect(resolveDuel(duel([]), BEFORE).state).toBe("OPEN");
  });

  it("is OPEN when only the challenger has called — the opponent can still accept", () => {
    expect(resolveDuel(duel([c(A, "PENDING")]), BEFORE).state).toBe("OPEN");
  });

  it("is OPEN when both called but the chain has not decided", () => {
    const r = resolveDuel(duel([c(A, "PENDING"), c(B, "PENDING")]), BEFORE);
    expect(r.state).toBe("OPEN");
    expect(r.result).toBeNull();
  });
});

describe("when someone never turns up", () => {
  it("EXPIRES if the opponent never called and the window closed", () => {
    const r = resolveDuel(duel([c(A, "WON")]), AFTER);
    expect(r.state).toBe("EXPIRED");
    expect(r.result).toBeNull();
  });

  it("EXPIRES if the CHALLENGER never called — issuing one is not enough", () => {
    const r = resolveDuel(duel([c(B, "WON")]), AFTER);
    expect(r.state).toBe("EXPIRED");
    expect(r.result).toBeNull();
  });

  it("does not hand a walkover win to whoever did call", () => {
    // A challenge nobody accepted must not become free points.
    expect(resolveDuel(duel([c(A, "WON")]), AFTER).result).toBeNull();
  });
});

describe("resolution", () => {
  const cases: Array<[CallStatus, CallStatus, string]> = [
    ["WON", "LOST", "CHALLENGER"],
    ["LOST", "WON", "OPPONENT"],
    ["WON", "WON", "DRAW"],
    ["LOST", "LOST", "DRAW"],
  ];
  for (const [challenger, opponent, want] of cases) {
    it(`challenger ${challenger}, opponent ${opponent} -> ${want}`, () => {
      const r = resolveDuel(duel([c(A, challenger), c(B, opponent)]), AFTER);
      expect(r.state).toBe("RESOLVED");
      expect(r.result).toBe(want);
    });
  }

  it("counts both taking the same winning side as a draw, not a defeat", () => {
    const r = resolveDuel(
      duel([c(A, "WON", { direction: "UP" }), c(B, "WON", { direction: "UP" })]),
      AFTER,
    );
    expect(r.result).toBe("DRAW");
  });

  it("resolves before the close if the chain already decided", () => {
    // Settlement can land early; there is no reason to wait on the clock.
    expect(resolveDuel(duel([c(A, "WON"), c(B, "LOST")]), BEFORE).state).toBe("RESOLVED");
  });
});

describe("voids", () => {
  it("is VOID when either side voided — nobody is punished for the venue's problem", () => {
    expect(resolveDuel(duel([c(A, "VOID"), c(B, "LOST")]), AFTER).state).toBe("VOID");
    expect(resolveDuel(duel([c(A, "WON"), c(B, "VOID")]), AFTER).state).toBe("VOID");
  });

  it("declares no winner on a void", () => {
    expect(resolveDuel(duel([c(A, "VOID"), c(B, "VOID")]), AFTER).result).toBeNull();
  });
});

describe("the exploit this must not allow", () => {
  it("uses the EARLIEST call, so calling both directions cannot win a duel", () => {
    // A hedges: UP first, then DOWN. Only the first counts, exactly as the
    // leaderboard scores it — otherwise a duel would be free to win.
    const r = resolveDuel(
      duel([
        c(A, "LOST", { direction: "UP", placedAtSec: 100, id: "first" }),
        c(A, "WON", { direction: "DOWN", placedAtSec: 200, id: "second" }),
        c(B, "WON"),
      ]),
      AFTER,
    );
    expect(r.challengerCall?.id).toBe("first");
    expect(r.result).toBe("OPPONENT");
  });

  it("breaks a same-second tie deterministically", () => {
    const r1 = resolveDuel(
      duel([
        c(A, "LOST", { placedAtSec: 100, id: "aaa" }),
        c(A, "WON", { placedAtSec: 100, id: "zzz" }),
        c(B, "LOST"),
      ]),
      AFTER,
    );
    expect(r1.challengerCall?.id).toBe("aaa");
  });

  it("ignores calls from wallets not in the duel", () => {
    const outsider = "0xCCccCCccCCccCCccCCccCCccCCccCCccCCccCCcc";
    const r = resolveDuel(duel([c(A, "WON"), c(B, "LOST"), c(outsider, "WON")]), AFTER);
    expect(r.result).toBe("CHALLENGER");
  });

  it("matches wallets case-insensitively", () => {
    const r = resolveDuel(
      { ...duel([c(A.toLowerCase(), "WON"), c(B.toUpperCase(), "LOST")]) },
      AFTER,
    );
    expect(r.result).toBe("CHALLENGER");
  });
});

describe("tally", () => {
  const outcome = (challengerStatus: CallStatus, opponentStatus: CallStatus) =>
    resolveDuel(duel([c(A, challengerStatus), c(B, opponentStatus)]), AFTER);

  it("counts from the perspective of the wallet asked about", () => {
    const list = [
      { challenger: A, opponent: B, outcome: outcome("WON", "LOST") },
      { challenger: A, opponent: B, outcome: outcome("LOST", "WON") },
      { challenger: A, opponent: B, outcome: outcome("WON", "WON") },
    ];
    expect(tallyDuels(A, list)).toMatchObject({ won: 1, lost: 1, drawn: 1 });
    // The same duels, seen from the other side.
    expect(tallyDuels(B, list)).toMatchObject({ won: 1, lost: 1, drawn: 1 });
  });

  it("counts a void as a draw, not a loss", () => {
    const list = [{ challenger: A, opponent: B, outcome: outcome("VOID", "WON") }];
    expect(tallyDuels(A, list)).toMatchObject({ drawn: 1, lost: 0 });
  });

  it("ignores duels the wallet is not part of", () => {
    const other = "0xDDddDDddDDddDDddDDddDDddDDddDDddDDddDDdd";
    const list = [{ challenger: A, opponent: B, outcome: outcome("WON", "LOST") }];
    expect(tallyDuels(other, list)).toMatchObject({ won: 0, lost: 0, drawn: 0 });
  });

  it("separates open from expired", () => {
    const list = [
      { challenger: A, opponent: B, outcome: resolveDuel(duel([c(A, "PENDING")]), BEFORE) },
      { challenger: A, opponent: B, outcome: resolveDuel(duel([c(A, "WON")]), AFTER) },
    ];
    expect(tallyDuels(A, list)).toMatchObject({ open: 1, expired: 1 });
  });
});
