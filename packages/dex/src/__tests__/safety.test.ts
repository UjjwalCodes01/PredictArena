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

describe("derived constants", () => {
  it("derives the gas ceiling from the SDK's own fee config, not a magic number", async () => {
    const { GAS_CEILING_WEI, SDK_DEFAULT_GAS } = await import("../config.js");
    const { DEFAULT_FEES } = await import("@somnia-chain/markets-sdk");
    expect(GAS_CEILING_WEI).toBe(SDK_DEFAULT_GAS * DEFAULT_FEES.maxFeePerGas);
    // Sanity: the measured envelope really is ~0.6 STT at the SDK's defaults.
    expect(GAS_CEILING_WEI).toBe(600_000_000_000_000_000n);
  });

  it("pins the SDK gas limit the SDK documents but does not export", async () => {
    // If this ever drifts, GAS_CEILING_WEI silently stops matching reality —
    // hence the assertion rather than a comment.
    const { SDK_DEFAULT_GAS } = await import("../config.js");
    expect(SDK_DEFAULT_GAS).toBe(10_000_000n);
  });
});
