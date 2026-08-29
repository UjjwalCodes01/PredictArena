/**
 * Week assignment. CLAUDE.md requires this to be test-first and table-driven.
 *
 * ISO-8601: weeks start Monday, and week 1 is the week containing 4 January.
 * The year-boundary cases are the whole reason this is a function rather than
 * an inline expression.
 */
import { describe, it, expect } from "vitest";
import { isoWeekId, weekIdForClose, weekStartUtc } from "../week.js";

const at = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000);

describe("isoWeekId", () => {
  const cases: Array<[string, string, string]> = [
    ["2026-01-05T00:00:00Z", "2026-W02", "a plain Monday"],
    ["2026-08-30T12:00:00Z", "2026-W35", "today, mid-week"],
    ["2026-08-31T00:00:00Z", "2026-W36", "Monday 00:00 starts the new week"],
    ["2026-08-30T23:59:59Z", "2026-W35", "one second before the reset"],
    // 1 Jan 2026 is a Thursday, so it belongs to week 1 of 2026.
    ["2026-01-01T00:00:00Z", "2026-W01", "New Year's Day in week 1"],
    // 1 Jan 2027 is a Friday -> still week 53 of 2026.
    ["2027-01-01T00:00:00Z", "2026-W53", "1 Jan belongs to the PREVIOUS ISO year"],
    // 31 Dec 2024 is a Tuesday -> week 1 of 2025.
    ["2024-12-31T00:00:00Z", "2025-W01", "31 Dec belongs to the NEXT ISO year"],
    ["2023-01-01T00:00:00Z", "2022-W52", "Sunday 1 Jan is the last week of the old year"],
  ];

  for (const [iso, want, label] of cases) {
    it(`${label}: ${iso} -> ${want}`, () => expect(isoWeekId(new Date(iso))).toBe(want));
  }

  it("is UTC-only — a local timezone must not shift the week", () => {
    // Same instant, expressed with an offset. Both must land in the same week.
    expect(isoWeekId(new Date("2026-08-31T00:30:00Z")))
      .toBe(isoWeekId(new Date("2026-08-31T02:30:00+02:00")));
  });

  it("pads single-digit weeks so ids sort lexicographically", () => {
    expect(isoWeekId(new Date("2026-01-08T00:00:00Z"))).toBe("2026-W02");
    expect("2026-W02" < "2026-W10").toBe(true);
  });
});

describe("weekIdForClose", () => {
  it("uses the window's CLOSE time, not when the call was placed", () => {
    // Placed 23:59 Sunday, closes 00:01 Monday -> the NEW week.
    const closesAt = at("2026-08-31T00:01:00Z");
    expect(weekIdForClose(closesAt)).toBe("2026-W36");
  });

  it("accepts unix seconds", () => {
    expect(weekIdForClose(at("2026-08-30T12:00:00Z"))).toBe("2026-W35");
  });
});

describe("weekStartUtc", () => {
  it("returns Monday 00:00:00 UTC for a week id", () => {
    expect(weekStartUtc("2026-W36").toISOString()).toBe("2026-08-31T00:00:00.000Z");
    expect(weekStartUtc("2026-W35").toISOString()).toBe("2026-08-24T00:00:00.000Z");
  });

  it("round-trips with isoWeekId", () => {
    for (const id of ["2026-W01", "2026-W35", "2026-W53", "2025-W01"]) {
      expect(isoWeekId(weekStartUtc(id))).toBe(id);
    }
  });

  it("rejects a malformed week id rather than guessing", () => {
    expect(() => weekStartUtc("nonsense")).toThrow();
    expect(() => weekStartUtc("2026-W00")).toThrow();
    expect(() => weekStartUtc("2026-W54")).toThrow();
  });
});
