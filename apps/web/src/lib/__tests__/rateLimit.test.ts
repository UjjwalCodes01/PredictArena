/**
 * Rate limiting.
 *
 * The properties that matter: a normal page load (a burst of a few requests)
 * must never be blocked, a sustained flood must be, and one client's traffic
 * must not consume another's budget.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { rateLimit, clientKey, resetRateLimits } from "../rateLimit.js";

beforeEach(() => resetRateLimits());

describe("rateLimit", () => {
  it("allows a burst up to capacity — a page load fires several at once", () => {
    for (let i = 0; i < 10; i += 1) {
      expect(rateLimit("a", { capacity: 10, refillPerSec: 1 }).ok).toBe(true);
    }
  });

  it("blocks the request past capacity", () => {
    for (let i = 0; i < 5; i += 1) rateLimit("b", { capacity: 5, refillPerSec: 1 });
    const blocked = rateLimit("b", { capacity: 5, refillPerSec: 1 });
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it("keeps clients independent", () => {
    for (let i = 0; i < 5; i += 1) rateLimit("c1", { capacity: 5, refillPerSec: 1 });
    expect(rateLimit("c1", { capacity: 5, refillPerSec: 1 }).ok).toBe(false);
    // A different caller still has a full bucket.
    expect(rateLimit("c2", { capacity: 5, refillPerSec: 1 }).ok).toBe(true);
  });

  it("refills over time", async () => {
    for (let i = 0; i < 3; i += 1) rateLimit("d", { capacity: 3, refillPerSec: 100 });
    expect(rateLimit("d", { capacity: 3, refillPerSec: 100 }).ok).toBe(false);
    await new Promise((r) => setTimeout(r, 40)); // 100/s => ~4 tokens back
    expect(rateLimit("d", { capacity: 3, refillPerSec: 100 }).ok).toBe(true);
  });

  it("never refills beyond capacity, however long it sits idle", async () => {
    // A slow refill on purpose. An earlier version of this test used 1000/s,
    // which regenerates a token in the microseconds BETWEEN two statements --
    // so it could never observe depletion and failed intermittently. The rate
    // has to be slow enough that elapsed test time is negligible.
    const opts = { capacity: 2, refillPerSec: 0.01 };

    // This call creates the bucket and spends the FIRST of the two tokens.
    expect(rateLimit("e", opts).ok).toBe(true);

    // Sit idle. At 0.01/s this earns 0.0003 of a token — effectively nothing.
    await new Promise((r) => setTimeout(r, 30));

    // Exactly `capacity` requests total get through, never more, no matter how
    // long the bucket sat there.
    expect(rateLimit("e", opts).ok).toBe(true);
    expect(rateLimit("e", opts).ok).toBe(false);
  });
});

describe("clientKey", () => {
  it("uses the first address in x-forwarded-for", () => {
    const r = new Request("https://x/", { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } });
    expect(clientKey(r)).toBe("1.2.3.4");
  });

  it("falls back to a shared key rather than skipping the limit", () => {
    expect(clientKey(new Request("https://x/"))).toBe("unknown");
  });

  it("ignores an empty header", () => {
    const r = new Request("https://x/", { headers: { "x-forwarded-for": "" } });
    expect(clientKey(r)).toBe("unknown");
  });
});
