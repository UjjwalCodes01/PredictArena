/**
 * The clock exists because AGENTS.md forbids trusting the browser clock for
 * cutoffs. These tests simulate a skewed machine, which is the whole point.
 */
import { describe, it, expect } from "vitest";
import { ServerClock } from "../time";

function fakeSource(opts: { chainSec: number; localMs: number; latencyMs?: number }) {
  const state = { ...opts, latencyMs: opts.latencyMs ?? 0 };
  return {
    state,
    source: {
      nowMs: () => state.localMs,
      fetchChainTimeSec: async () => {
        state.localMs += state.latencyMs;
        return state.chainSec;
      },
    },
  };
}

describe("ServerClock", () => {
  it("is unsynced before the first sync and reports local time", () => {
    const { source } = fakeSource({ chainSec: 1_000_000, localMs: 500_000 });
    const clock = new ServerClock(source);
    expect(clock.isSynced).toBe(false);
    expect(clock.nowMs()).toBe(500_000);
  });

  it("corrects a machine running two minutes FAST", async () => {
    // Local clock says 1,000,120s; the chain says 1,000,000s.
    const { source } = fakeSource({ chainSec: 1_000_000, localMs: 1_000_120_000 });
    const clock = new ServerClock(source);
    await clock.sync();
    expect(clock.offsetSeconds).toBe(-120);
    expect(clock.nowSec()).toBe(1_000_000);
  });

  it("corrects a machine running two minutes SLOW", async () => {
    const { source } = fakeSource({ chainSec: 1_000_000, localMs: 999_880_000 });
    const clock = new ServerClock(source);
    await clock.sync();
    expect(clock.offsetSeconds).toBe(120);
    expect(clock.nowSec()).toBe(1_000_000);
  });

  it("splits round-trip latency rather than attributing all of it to one side", async () => {
    const { source } = fakeSource({ chainSec: 1_000_000, localMs: 1_000_000_000, latencyMs: 400 });
    const clock = new ServerClock(source);
    await clock.sync();
    // Midpoint of the 400ms round trip is 200ms, so the offset is -200ms.
    expect(clock.nowMs()).toBe(1_000_000_000 + 400 - 200);
  });

  it("computes a countdown from corrected time, not the skewed local clock", async () => {
    // A machine 5 minutes fast would otherwise think the window already closed.
    const { source } = fakeSource({ chainSec: 1_000_000, localMs: 1_000_300_000 });
    const clock = new ServerClock(source);
    await clock.sync();
    expect(Math.round(clock.secondsUntil(1_000_060))).toBe(60);
    expect(clock.secondsUntil(999_900)).toBeLessThan(0);
  });

  it("accepts a timestamp as number, string or bigint (indexer rows are strings)", async () => {
    const { source } = fakeSource({ chainSec: 1_000_000, localMs: 1_000_000_000 });
    const clock = new ServerClock(source);
    await clock.sync();
    expect(Math.round(clock.secondsUntil(1_000_060))).toBe(60);
    expect(Math.round(clock.secondsUntil("1000060"))).toBe(60);
    expect(Math.round(clock.secondsUntil(1_000_060n))).toBe(60);
  });

  it("goes stale and re-syncs only when needed", async () => {
    const { state, source } = fakeSource({ chainSec: 1_000_000, localMs: 1_000_000_000 });
    const clock = new ServerClock(source, 60_000);
    await clock.sync();
    expect(clock.isStale).toBe(false);

    state.localMs += 30_000;
    expect(clock.isStale).toBe(false);
    state.localMs += 40_000;
    expect(clock.isStale).toBe(true);

    state.chainSec = 1_000_070;
    await clock.ensureFresh();
    expect(clock.isStale).toBe(false);
  });
});
