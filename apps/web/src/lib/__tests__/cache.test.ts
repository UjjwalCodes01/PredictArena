/**
 * Cache behaviour.
 *
 * The properties that matter are not "it caches" -- they are that a cold burst
 * makes ONE upstream call, and that nobody waits once a value exists.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { cached, clearCache } from "../cache.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => clearCache());

describe("cached", () => {
  it("calls upstream once and reuses the value while fresh", async () => {
    const fn = vi.fn(async () => "v1");
    expect(await cached("k", 1000, fn)).toBe("v1");
    expect(await cached("k", 1000, fn)).toBe("v1");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("collapses a concurrent cold burst into ONE upstream call", async () => {
    let calls = 0;
    const fn = async (): Promise<number> => {
      calls += 1;
      await sleep(20);
      return calls;
    };
    const results = await Promise.all(Array.from({ length: 10 }, () => cached("burst", 1000, fn)));
    expect(calls).toBe(1);
    expect(new Set(results).size).toBe(1);
  });

  it("serves a stale value IMMEDIATELY rather than waiting on the refresh", async () => {
    let n = 0;
    const fn = async (): Promise<string> => {
      n += 1;
      await sleep(50); // a slow upstream, like a suspended database
      return `v${n}`;
    };

    expect(await cached("swr", 1, fn)).toBe("v1");
    await sleep(10); // now stale

    // The point of the whole mechanism: this must return at once with the old
    // value, NOT block for the 50ms refresh.
    const started = Date.now();
    const value = await cached("swr", 1, fn);
    const waited = Date.now() - started;

    expect(value).toBe("v1");
    expect(waited).toBeLessThan(25);

    // And the refresh it kicked off does land.
    await sleep(80);
    expect(await cached("swr", 10_000, fn)).toBe("v2");
  });

  it("keeps serving the last good value when upstream starts failing", async () => {
    let ok = true;
    const fn = async (): Promise<string> => {
      if (!ok) throw new Error("upstream down");
      return "good";
    };
    expect(await cached("fail", 1, fn)).toBe("good");
    ok = false;
    await sleep(10);
    // Stale-but-good beats an error page.
    expect(await cached("fail", 1, fn)).toBe("good");
  });

  it("propagates the error when there is nothing cached to fall back on", async () => {
    await expect(
      cached("cold-fail", 1000, async () => { throw new Error("upstream down"); }),
    ).rejects.toThrow("upstream down");
  });

  it("keeps keys independent", async () => {
    expect(await cached("a", 1000, async () => 1)).toBe(1);
    expect(await cached("b", 1000, async () => 2)).toBe(2);
  });
});
