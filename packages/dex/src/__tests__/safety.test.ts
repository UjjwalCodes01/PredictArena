/**
 * The testnet-only rail. CLAUDE.md hard rule 1 has no second chance, so it is
 * tested rather than assumed.
 */
import { describe, it, expect } from "vitest";
import { assertTestnetConfig, MAINNET_HOSTS, TESTNET_CHAIN_ID } from "../config.js";
import { DexError } from "../errors.js";

const shannon = { chainId: TESTNET_CHAIN_ID, urls: ["https://dream-rpc.somnia.network"] };

describe("assertTestnetConfig", () => {
  it("accepts a correct Shannon config", () => {
    expect(() => assertTestnetConfig(shannon)).not.toThrow();
  });

  it("defaults to Shannon when no chain id is supplied", () => {
    expect(() => assertTestnetConfig({ urls: [] })).not.toThrow();
  });

  it("refuses mainnet chain 5031", () => {
    try {
      assertTestnetConfig({ chainId: 5031, urls: [] });
      throw new Error("should have thrown");
    } catch (e) {
      expect(DexError.is(e, "MAINNET_FORBIDDEN")).toBe(true);
    }
  });

  it("refuses Elwood (50313) and says why", () => {
    try {
      assertTestnetConfig({ chainId: 50313, urls: [] });
      throw new Error("should have thrown");
    } catch (e) {
      expect(DexError.is(e, "CHAIN_MISMATCH")).toBe(true);
      expect((e as DexError).action).toMatch(/Elwood/);
    }
  });

  it("refuses every known mainnet host, wherever it appears in the URL", () => {
    for (const host of MAINNET_HOSTS) {
      expect(() => assertTestnetConfig({ chainId: TESTNET_CHAIN_ID, urls: [`https://${host}/v1/graphql`] }))
        .toThrow(DexError);
      // Also when embedded rather than being the whole host.
      expect(() => assertTestnetConfig({ chainId: TESTNET_CHAIN_ID, urls: [`https://proxy/${host}`] }))
        .toThrow(DexError);
    }
  });

  it("is case-insensitive about hosts", () => {
    expect(() => assertTestnetConfig({ chainId: TESTNET_CHAIN_ID, urls: ["https://PRD.SMK.SOMNIA.HOST/v1/graphql"] }))
      .toThrow(DexError);
  });

  it("ignores undefined URLs rather than crashing", () => {
    expect(() => assertTestnetConfig({ chainId: TESTNET_CHAIN_ID, urls: [undefined, "https://dream-rpc.somnia.network"] }))
      .not.toThrow();
  });

  it("catches the production indexer, the easiest mainnet host to set by accident", () => {
    // The SDK's own README uses prd.smk.somnia.host in its first example.
    expect(() => assertTestnetConfig({ chainId: TESTNET_CHAIN_ID, urls: ["https://prd.smk.somnia.host/v1/graphql"] }))
      .toThrow(DexError);
  });
});
