/**
 * Reading the forecaster's key from an environment variable.
 *
 * Written after a production outage of the feature: a value pasted into a
 * dashboard textarea failed a strict anchored match, `aiWallet()` returned
 * null, and the site reported "no forecaster configured" — indistinguishable
 * from never having set it up. The paste was almost certainly fine apart from
 * whitespace.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = `0x${"a".repeat(64)}` as const;
let saved: string | undefined;

beforeEach(() => { saved = process.env["AI_PRIVATE_KEY"]; });
afterEach(() => {
  if (saved === undefined) delete process.env["AI_PRIVATE_KEY"];
  else process.env["AI_PRIVATE_KEY"] = saved;
  vi.resetModules();
});

async function walletFor(value: string | undefined): Promise<string | null> {
  if (value === undefined) delete process.env["AI_PRIVATE_KEY"];
  else process.env["AI_PRIVATE_KEY"] = value;
  vi.resetModules();
  const { aiWallet } = await import("../server");
  return aiWallet();
}

describe("aiWallet", () => {
  it("reads a clean key", async () => {
    expect(await walletFor(KEY)).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("survives the trailing newline a dashboard adds", async () => {
    expect(await walletFor(`${KEY}\n`)).toMatch(/^0x/);
  });

  it("survives surrounding whitespace", async () => {
    expect(await walletFor(`  ${KEY}  `)).toMatch(/^0x/);
  });

  it("survives quotes a shell or dashboard may keep", async () => {
    expect(await walletFor(`"${KEY}"`)).toMatch(/^0x/);
  });

  it("accepts raw hex without the 0x prefix", async () => {
    expect(await walletFor("a".repeat(64))).toMatch(/^0x/);
  });

  it("is null when genuinely unset", async () => {
    expect(await walletFor(undefined)).toBeNull();
    expect(await walletFor("")).toBeNull();
    expect(await walletFor("   ")).toBeNull();
  });

  it("refuses an address pasted in place of a key, and says why", async () => {
    // The likeliest wrong paste. Silence here is what cost a day.
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m) => { errors.push(String(m)); });
    expect(await walletFor(`0x${"b".repeat(40)}`)).toBeNull();
    expect(errors.join(" ")).toMatch(/not a 32-byte hex key/);
    spy.mockRestore();
  });

  it("refuses a truncated key rather than deriving the wrong wallet", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await walletFor(`0x${"a".repeat(63)}`)).toBeNull();
    spy.mockRestore();
  });
});
