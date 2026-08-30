/**
 * Guards on the settlement write path.
 *
 * These exist because of a real defect: `settleCallsForWindow` derived the
 * winner with `winningOutcome === 0 ? "UP" : "DOWN"`, so a NULL outcome
 * silently meant "Down won" -- marking every Up call LOST and every Down call
 * WON on a window whose result was not actually known.
 *
 * Fabricating a result is worse than settling nothing, so the precondition is
 * pinned here. The stub database throws if it is ever reached, which is how we
 * prove the guard fires BEFORE any row is touched.
 */
import { describe, it, expect } from "vitest";
import { settleCallsForWindow } from "../queries.js";
import type { Database } from "../client.js";

/** Any use of this is a test failure: nothing should reach the database. */
const unreachableDb = new Proxy({}, {
  get() {
    throw new Error("database was touched despite an invalid outcome");
  },
}) as unknown as Database;

const base = { windowId: "0xwindow", settledAt: new Date("2026-08-30T00:00:00Z") };

describe("settleCallsForWindow — outcome validation", () => {
  it("REFUSES a null outcome on a resolved window rather than defaulting to DOWN", async () => {
    await expect(
      settleCallsForWindow(unreachableDb, { ...base, winningOutcome: null, voided: false }),
    ).rejects.toThrow(/must be 0 or 1/);
  });

  it("refuses an out-of-range outcome", async () => {
    for (const bad of [-1, 2, 7]) {
      await expect(
        settleCallsForWindow(unreachableDb, { ...base, winningOutcome: bad, voided: false }),
      ).rejects.toThrow(/must be 0 or 1/);
    }
  });

  it("names the window in the error, so a bad settlement is traceable", async () => {
    await expect(
      settleCallsForWindow(unreachableDb, { ...base, winningOutcome: null, voided: false }),
    ).rejects.toThrow(/0xwindow/);
  });

  it("does NOT require an outcome when the window voided — a void has no winner", async () => {
    // Reaching the database here is the correct behaviour, so the stub's throw
    // is what proves the guard let it through.
    await expect(
      settleCallsForWindow(unreachableDb, { ...base, winningOutcome: null, voided: true }),
    ).rejects.toThrow(/database was touched/);
  });

  it("accepts both legal outcomes", async () => {
    for (const ok of [0, 1]) {
      await expect(
        settleCallsForWindow(unreachableDb, { ...base, winningOutcome: ok, voided: false }),
      ).rejects.toThrow(/database was touched/);
    }
  });
});
