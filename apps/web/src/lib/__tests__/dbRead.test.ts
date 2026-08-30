/**
 * Cold-database retry.
 *
 * Neon suspends when idle and the first query afterwards can time out at the
 * connection layer. Without a retry the very first visitor to a cold
 * deployment gets a 503 on the leaderboard, activity, portfolio and profile at
 * once — which is exactly the state a judge arrives in.
 */
import { describe, it, expect, vi } from "vitest";
import { dbRead } from "../server.js";

/** Exercise the retry logic without waiting seven real seconds. */
const FAST = 1;

describe("dbRead", () => {
  it("returns the value when the first attempt works", async () => {
    const fn = vi.fn(async () => "ok");
    expect(await dbRead(fn, 3, FAST)).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("recovers when the database was merely asleep", async () => {
    let n = 0;
    const fn = async (): Promise<string> => {
      n += 1;
      if (n === 1) throw new Error("connect timeout");
      return "awake";
    };
    expect(await dbRead(fn, 3, FAST)).toBe("awake");
    expect(n).toBe(2);
  });

  it("survives two failures before succeeding", async () => {
    let n = 0;
    const fn = async (): Promise<string> => {
      n += 1;
      if (n < 3) throw new Error("connect timeout");
      return "awake";
    };
    expect(await dbRead(fn, 3, FAST)).toBe("awake");
    expect(n).toBe(3);
  });

  it("gives up rather than holding the request open forever", async () => {
    const fn = vi.fn(async () => { throw new Error("database is gone"); });
    await expect(dbRead(fn, 3, FAST)).rejects.toThrow("database is gone");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("surfaces the LAST error, not the first", async () => {
    let n = 0;
    const fn = async (): Promise<never> => {
      n += 1;
      throw new Error(`failure ${n}`);
    };
    await expect(dbRead(fn, 3, FAST)).rejects.toThrow("failure 3");
  });

  it("honours a custom attempt count", async () => {
    const fn = vi.fn(async () => { throw new Error("down"); });
    await expect(dbRead(fn, 2, FAST)).rejects.toThrow("down");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
