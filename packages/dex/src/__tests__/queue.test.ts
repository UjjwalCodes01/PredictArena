import { describe, it, expect } from "vitest";
import { RequestQueue } from "../queue.js";
import { DexError } from "../errors.js";

const noSleep = async (): Promise<void> => {};

describe("RequestQueue retry policy", () => {
  it("returns the value when the call succeeds first time", async () => {
    const q = new RequestQueue({ sleep: noSleep });
    await expect(q.run(async () => 42)).resolves.toBe(42);
  });

  it("retries a retryable failure and eventually succeeds", async () => {
    const q = new RequestQueue({ maxAttempts: 3, sleep: noSleep });
    let calls = 0;
    const result = await q.run(async () => {
      calls += 1;
      if (calls < 3) throw new DexError("API_DOWN", "indexer fetch failed");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("does NOT retry a business failure — retrying WINDOW_CLOSED just wastes time", async () => {
    const q = new RequestQueue({ maxAttempts: 5, sleep: noSleep });
    let calls = 0;
    await expect(
      q.run(async () => {
        calls += 1;
        throw new DexError("WINDOW_CLOSED", "locked");
      }),
    ).rejects.toBeInstanceOf(DexError);
    expect(calls).toBe(1);
  });

  it("gives up after maxAttempts and rethrows the last error", async () => {
    const q = new RequestQueue({ maxAttempts: 2, sleep: noSleep });
    let calls = 0;
    await expect(
      q.run(async () => {
        calls += 1;
        throw new DexError("RATE_LIMITED", "429");
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(calls).toBe(2);
  });

  it("classifies raw transport errors as retryable API_DOWN", async () => {
    const q = new RequestQueue({ maxAttempts: 2, sleep: noSleep });
    let calls = 0;
    await expect(
      q.run(async () => {
        calls += 1;
        // Exactly the string the SDK produced when the Portfolio query died.
        throw new Error("indexer Portfolio failed: fetch failed");
      }),
    ).rejects.toMatchObject({ code: "API_DOWN" });
    expect(calls).toBe(2);
  });
});

describe("RequestQueue backoff", () => {
  it("grows exponentially and is capped", () => {
    // random() = 1 gives the top of the jitter range, i.e. the raw curve.
    const q = new RequestQueue({ baseDelayMs: 100, maxDelayMs: 800, random: () => 1 });
    expect(q.backoffFor(1)).toBe(100);
    expect(q.backoffFor(2)).toBe(200);
    expect(q.backoffFor(3)).toBe(400);
    expect(q.backoffFor(4)).toBe(800);
    expect(q.backoffFor(9)).toBe(800);
  });

  it("uses FULL jitter, so a fleet does not resynchronise after an outage", () => {
    const q = new RequestQueue({ baseDelayMs: 1000, random: () => 0 });
    expect(q.backoffFor(3)).toBe(0);
    const half = new RequestQueue({ baseDelayMs: 1000, random: () => 0.5 });
    expect(half.backoffFor(3)).toBe(2000);
  });
});

describe("RequestQueue concurrency", () => {
  it("never exceeds the configured concurrency", async () => {
    const q = new RequestQueue({ concurrency: 2, sleep: noSleep });
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        q.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active -= 1;
        }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("releases its slot even when the call throws", async () => {
    const q = new RequestQueue({ concurrency: 1, maxAttempts: 1, sleep: noSleep });
    await expect(q.run(async () => { throw new DexError("UNKNOWN", "boom"); })).rejects.toThrow();
    await expect(q.run(async () => "still works")).resolves.toBe("still works");
  });
});
