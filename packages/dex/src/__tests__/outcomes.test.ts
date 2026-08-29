/**
 * Outcome mapping and window timing.
 *
 * `statusFor` is where a boolean would have been used by a less careful
 * implementation — and would have made VOID unrepresentable. VOID is a real and
 * COMMON outcome on Shannon, so every case is pinned here.
 */
import { describe, it, expect } from "vitest";
import { statusFor, type Settlement } from "../positions.js";
import { headroomSecFor, outcomeIndexFor, directionFor, MarketStatus, type Direction } from "../windows.js";
import { idempotencyKey } from "../orders.js";

const settlement = (over: Partial<Settlement>): Settlement => ({
  marketId: "0x00",
  status: "PENDING",
  winningOutcome: null,
  winningDirection: null,
  closesAtSec: 0,
  onchainStatus: MarketStatus.Trading,
  ...over,
});

describe("statusFor", () => {
  const cases: Array<[string, Settlement, Direction, string]> = [
    ["pending stays pending (Up)", settlement({}), "UP", "PENDING"],
    ["pending stays pending (Down)", settlement({}), "DOWN", "PENDING"],
    ["called Up, Up won", settlement({ status: "RESOLVED", winningOutcome: 0, winningDirection: "UP" }), "UP", "WON"],
    ["called Up, Down won", settlement({ status: "RESOLVED", winningOutcome: 1, winningDirection: "DOWN" }), "UP", "LOST"],
    ["called Down, Down won", settlement({ status: "RESOLVED", winningOutcome: 1, winningDirection: "DOWN" }), "DOWN", "WON"],
    ["called Down, Up won", settlement({ status: "RESOLVED", winningOutcome: 0, winningDirection: "UP" }), "DOWN", "LOST"],
    ["void is VOID for Up", settlement({ status: "VOIDED" }), "UP", "VOID"],
    ["void is VOID for Down", settlement({ status: "VOIDED" }), "DOWN", "VOID"],
  ];

  for (const [label, s, called, want] of cases) {
    it(`${label} -> ${want}`, () => expect(statusFor(s, called)).toBe(want));
  }

  it("never collapses VOID into LOST — a void refunds, it is not a loss", () => {
    expect(statusFor(settlement({ status: "VOIDED" }), "UP")).not.toBe("LOST");
    expect(statusFor(settlement({ status: "VOIDED" }), "DOWN")).not.toBe("LOST");
  });
});

describe("outcome index mapping", () => {
  it("0 is Up and 1 is Down, both ways", () => {
    expect(outcomeIndexFor("UP")).toBe(0);
    expect(outcomeIndexFor("DOWN")).toBe(1);
    expect(directionFor(0)).toBe("UP");
    expect(directionFor(1)).toBe("DOWN");
  });

  it("round-trips", () => {
    for (const d of ["UP", "DOWN"] as const) expect(directionFor(outcomeIndexFor(d))).toBe(d);
  });
});

describe("headroomSecFor", () => {
  it("scales with the series instead of using one fixed threshold", () => {
    // A flat 300s rule would reject every 60s and 300s window outright.
    expect(headroomSecFor(60)).toBe(9);
    expect(headroomSecFor(300)).toBe(45);
    expect(headroomSecFor(900)).toBe(60);
  });

  it("is clamped at both ends", () => {
    expect(headroomSecFor(1)).toBe(5);          // floor
    expect(headroomSecFor(86_400)).toBe(60);    // ceiling
  });

  it("falls back safely for missing or nonsense intervals", () => {
    expect(headroomSecFor(0)).toBe(15);
    expect(headroomSecFor(-5)).toBe(15);
    expect(headroomSecFor(Number.NaN)).toBe(15);
  });
});

describe("idempotencyKey", () => {
  const wallet = "0xf06243d774F3872F974F3d01da55C2E050F2B542" as const;
  const marketA = `0x${"a".repeat(64)}` as const;
  const marketB = `0x${"b".repeat(64)}` as const;

  it("is deterministic for the same wallet and window", () => {
    expect(idempotencyKey(wallet, marketA)).toBe(idempotencyKey(wallet, marketA));
  });

  it("differs across windows and across wallets", () => {
    const other = "0x7B89B524045dAa2626eE68cF8d2DAbD74b725872" as const;
    expect(idempotencyKey(wallet, marketA)).not.toBe(idempotencyKey(wallet, marketB));
    expect(idempotencyKey(wallet, marketA)).not.toBe(idempotencyKey(other, marketA));
  });

  it("fits in the 64 bits userData carries", () => {
    expect(idempotencyKey(wallet, marketA)).toBeLessThan(1n << 64n);
    expect(idempotencyKey(wallet, marketA)).toBeGreaterThanOrEqual(0n);
  });
});
