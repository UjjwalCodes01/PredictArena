/**
 * Upstream deadlines.
 *
 * Serverless functions are killed at a hard wall time. An upstream that hangs
 * past it takes the function with it and the caller gets a bare 504 — no code,
 * no action, nothing the UI can switch on. Measured in production: a cold
 * `/api/claimable` took 75 seconds.
 */
import { describe, it, expect, vi } from "vitest";
import { withDeadline } from "../server.js";

const never = (): Promise<never> => new Promise(() => {});
const after = <T>(ms: number, v: T): Promise<T> =>
  new Promise((r) => setTimeout(() => r(v), ms));

describe("withDeadline", () => {
  it("returns the value when the work finishes in time", async () => {
    expect(await withDeadline("fast", 100, () => after(5, "ok"))).toBe("ok");
  });

  it("rejects — naming the call — when the work hangs", async () => {
    await expect(withDeadline("getClaimable", 20, never)).rejects.toThrow(
      /getClaimable exceeded 20ms/,
    );
  });

  it("propagates a real upstream failure rather than masking it as a timeout", async () => {
    await expect(
      withDeadline("boom", 500, async () => {
        throw new Error("venue returned 500");
      }),
    ).rejects.toThrow("venue returned 500");
  });

  it("does not leave a timer holding the process open", async () => {
    const spy = vi.spyOn(global, "clearTimeout");
    await withDeadline("tidy", 500, () => after(1, "done"));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("resolves a falsy value correctly", async () => {
    // A guard that treats 0 or null as "no result" would corrupt a balance.
    expect(await withDeadline("zero", 100, async () => 0)).toBe(0);
    expect(await withDeadline("null", 100, async () => null)).toBeNull();
  });
});
