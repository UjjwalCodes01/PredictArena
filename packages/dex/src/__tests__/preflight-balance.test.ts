/**
 * Which balance a call must clear before it may be signed.
 *
 * From production, 5 Sep 2026: a player holding 89.07 tUSDC staked 10 on a
 * long-shot Down at ~2c. Our preflight compared their balance to the ESCROW
 * (the 10) and let it through; the pool then tried to pull the full contract
 * count — 263.15, its worst-case settlement — and the transaction reverted
 * on-chain with ERC20InsufficientBalance (0xe450d38c). The UI blamed "the
 * window locked or the price moved", which was wrong twice over: gas was
 * burned, and the advice would never have fixed it.
 *
 * The rule was already written down for ALLOWANCES in approval.test.ts: the
 * pool requires `quantity`, not escrow. The same pool pulls the same amount,
 * so the BALANCE check must use the same figure. These tests pin that, with
 * the numbers from the incident.
 */
import { describe, it, expect } from "vitest";
import { preflightCall } from "../orders";
import { MarketStatus, headroomSecFor, type Window } from "../windows";
import { DexError } from "../errors";
import type { DexClient } from "../client";
import type { Quote } from "../orders";

const D = 6;

// Micro-tUSDC (6dp), written out as integers: the no-float-money rule applies
// to tests too, and the incident's own figures are exact in micro units.
const HELD_89_07 = 89_070_000n;
const STAKE_ESCROW = 9_999_700n; // ~10 tUSDC
const QUANTITY_263_15 = 263_150_000n; // what the pool pulls at ~2c
const HELD_300 = 300_000_000n;
const HELD_2 = 2_000_000n;
const EVEN_ESCROW = 10_000_000n;
const EVEN_QUANTITY = 20_030_000n;

/** Enough STT that gas never interferes with what these tests measure. */
const PLENTY_OF_STT = 10n ** 19n;

function stubClient(opts: { balance: bigint; allowance?: bigint }): DexClient {
  return {
    collateral: { address: "0xc011a7e0", symbol: "tUSDC", decimals: D },
    queue: { run: <T>(fn: () => Promise<T>) => fn() },
    rpc: {
      getBalance: async () => PLENTY_OF_STT,
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "balanceOf") return opts.balance;
        if (functionName === "allowance") return opts.allowance ?? 2n ** 128n;
        throw new Error(`unexpected read: ${functionName}`);
      },
    },
  } as unknown as DexClient;
}

const window = {
  marketId: "0xmarket",
  pool: "0xpool",
  intervalSec: 14_400,
  secondsLeft: headroomSecFor(14_400) + 600,
  onchain: { status: MarketStatus.Trading },
} as unknown as Window;

/** The incident's quote: 10 tUSDC at ~2c bought 263.15 contracts. */
const longshot = { escrow: STAKE_ESCROW, quantity: QUANTITY_263_15 } as unknown as Quote;

describe("preflightCall — balance is judged against what the pool PULLS", () => {
  it("refuses the incident's exact shape: balance covers the stake but not the quantity", async () => {
    const client = stubClient({ balance: HELD_89_07 });
    await expect(
      preflightCall(client, { window, quote: longshot, account: "0xabc" as `0x${string}` }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STAKE" });
  });

  it("explains the escrow mechanic, so the player learns the real rule", async () => {
    // "Get tUSDC from the faucet" is the wrong advice for someone holding 89:
    // the actionable move is a smaller stake or a likelier side. The message
    // must name the held-until-settlement amount.
    const client = stubClient({ balance: HELD_89_07 });
    const err = await preflightCall(client, {
      window, quote: longshot, account: "0xabc" as `0x${string}`,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DexError);
    const text = `${(err as DexError).message} ${(err as DexError).action ?? ""}`;
    expect(text).toMatch(/263\.15/);
    expect(text).toMatch(/until .*settle|settlement/i);
    expect(text).toMatch(/smaller stake/i);
  });

  it("passes when the balance covers the full contract count", async () => {
    const client = stubClient({ balance: HELD_300 });
    const out = await preflightCall(client, {
      window, quote: longshot, account: "0xabc" as `0x${string}`,
    });
    expect(out.collateralBalance).toBe(HELD_300);
  });

  it("still sends a genuinely broke wallet to the faucet", async () => {
    // Balance below even the stake: the old message was right for this case,
    // and must survive the fix.
    const client = stubClient({ balance: HELD_2 });
    const err = await preflightCall(client, {
      window, quote: longshot, account: "0xabc" as `0x${string}`,
    }).catch((e: unknown) => e);
    expect((err as DexError).code).toBe("INSUFFICIENT_STAKE");
    expect(`${(err as DexError).action}`).toMatch(/faucet/i);
  });

  it("an even-money call is unaffected — quantity ≈ 2x stake stays well inside a funded wallet", async () => {
    const evenMoney = { escrow: EVEN_ESCROW, quantity: EVEN_QUANTITY } as unknown as Quote;
    const client = stubClient({ balance: HELD_89_07 });
    await expect(
      preflightCall(client, { window, quote: evenMoney, account: "0xabc" as `0x${string}` }),
    ).resolves.toBeDefined();
  });
});
