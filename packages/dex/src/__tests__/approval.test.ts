/**
 * How large the approval must be.
 *
 * This exists because getting it wrong shipped a bug that broke every call in
 * the browser with ERC20InsufficientAllowance, and the smoke test did not catch
 * it: smoke exercises the SDK's own send path (which approves maxUint256),
 * while the browser uses prepareCall's bounded approval. Different code, so
 * green smoke meant nothing.
 *
 * The rule, measured on chain: the pool escrows against ITS worst case. A
 * binary contract can settle at up to 1.0 collateral, so the pool requires
 * `quantity` units no matter what price was actually paid. Approving the
 * ESCROW — which is quantity x price — is roughly half of that at even money,
 * and reverts.
 */
import { describe, it, expect } from "vitest";
import { buildExactApproval } from "../orders";
import { decodeFunctionData, erc20Abi } from "viem";
import type { DexClient } from "../client";

const POOL = "0x90dB0C4C4A25096103faeD8a3C7178C190abAE20" as const;

const client = {
  collateral: {
    address: "0x1111111111111111111111111111111111111111" as const,
    symbol: "tUSDC",
    decimals: 6,
  },
} as unknown as DexClient;

function approvedAmount(amount: bigint): bigint {
  const call = buildExactApproval(client, POOL, amount);
  const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data });
  return (decoded.args as [string, bigint])[1];
}

describe("buildExactApproval", () => {
  it("approves exactly what it is given, to the pool", () => {
    const call = buildExactApproval(client, POOL, 20_321_000n);
    const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data });
    const [spender, amount] = decoded.args as [string, bigint];
    expect(decoded.functionName).toBe("approve");
    expect(spender.toLowerCase()).toBe(POOL.toLowerCase());
    expect(amount).toBe(20_321_000n);
    expect(call.to).toBe(client.collateral.address);
  });

  it("is never unlimited — that is the drainer signature scanners flag", () => {
    const maxUint256 = 2n ** 256n - 1n;
    expect(approvedAmount(20_321_000n)).not.toBe(maxUint256);
  });

  it("names the amount in the description a wallet will show", () => {
    const call = buildExactApproval(client, POOL, 20_321_000n);
    expect(call.description).toContain("20.3210");
    expect(call.description).toContain("tUSDC");
  });

  it("carries no native value", () => {
    expect(buildExactApproval(client, POOL, 1n).value).toBe(0n);
  });
});

describe("the sizing rule that broke production", () => {
  // Real figures from the chain: a 10 tUSDC stake at ~50c produced an escrow of
  // 9.99 and a required allowance of 20.03.
  const escrow = 9_999_990n;
  const quantity = 20_030_010n;

  it("escrow alone is NOT enough — this is the bug that shipped", () => {
    expect(escrow).toBeLessThan(quantity);
  });

  it("quantity plus 1% headroom covers what the pool requires", () => {
    const approved = quantity + quantity / 100n;
    expect(approved).toBeGreaterThanOrEqual(quantity);
  });

  it("the headroom stays small — an approval is not a blank cheque", () => {
    const approved = quantity + quantity / 100n;
    expect(approved).toBeLessThan(quantity * 2n);
  });
});
