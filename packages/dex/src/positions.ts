/**
 * Positions and settlement.
 *
 * Outcome is an enum, never a boolean (CLAUDE.md): VOID is a real, common
 * result on testnet, and a boolean cannot express it.
 *
 * Everything here reads the CHAIN as truth. The indexer is used only to
 * discover which markets to look at, and its failure degrades the result rather
 * than breaking it — Phase 0 lost a won position to an indexer blip during
 * redemption, which is exactly the failure this module exists to prevent.
 */
import { erc20Abi } from "viem";
import type { DexClient } from "./client.js";
import { explorerTx } from "./config.js";
import { DexError, asDexError } from "./errors.js";
import { MarketStatus, directionFor, outcomeIndexFor, type Direction } from "./windows.js";

/** The only legal outcome values. Booleans are forbidden. */
export type PositionStatus = "PENDING" | "WON" | "LOST" | "VOID" | "FAILED";

export interface Settlement {
  readonly marketId: `0x${string}`;
  /** PENDING until the market finalises. */
  readonly status: "PENDING" | "RESOLVED" | "VOIDED";
  /** 0 = Up, 1 = Down. Null while pending or when voided. */
  readonly winningOutcome: number | null;
  readonly winningDirection: Direction | null;
  readonly closesAtSec: number;
  readonly onchainStatus: number;
}

/** Settlement truth for one window, read from chain. */
export async function getSettlement(client: DexClient, marketId: `0x${string}`): Promise<Settlement> {
  const onchain = await client.queue
    .run(() => client.exchange.client.getMarketOnchain(marketId))
    .catch((e) => {
      throw asDexError(e, "API_DOWN");
    });

  const base = {
    marketId,
    closesAtSec: Number(onchain.expiry),
    onchainStatus: onchain.status,
  };

  if (onchain.isVoided) {
    return { ...base, status: "VOIDED", winningOutcome: null, winningDirection: null };
  }
  if (onchain.isResolved) {
    return {
      ...base,
      status: "RESOLVED",
      winningOutcome: onchain.winningOutcome,
      winningDirection: directionFor(onchain.winningOutcome),
    };
  }
  return { ...base, status: "PENDING", winningOutcome: null, winningDirection: null };
}

/** Maps a settlement plus the direction a wallet called into a position status. */
export function statusFor(settlement: Settlement, called: Direction): PositionStatus {
  if (settlement.status === "PENDING") return "PENDING";
  if (settlement.status === "VOIDED") return "VOID";
  return settlement.winningDirection === called ? "WON" : "LOST";
}

export interface Position {
  readonly marketId: `0x${string}`;
  readonly direction: Direction;
  /** Outcome tokens held, in collateral base units. */
  readonly contracts: bigint;
  readonly status: PositionStatus;
  readonly settlement: Settlement;
  /**
   * What redeeming would pay now: 1 per contract when won, 0.5 per contract on
   * a void (both sides redeem — a refund, not a loss), 0 when lost.
   */
  readonly claimable: bigint;
}

/** Outcome-token balance for one side of one market, read from chain. */
export async function getOutcomeBalance(
  client: DexClient,
  params: { marketId: `0x${string}`; account: `0x${string}`; direction: Direction },
): Promise<bigint> {
  const onchain = await client.queue.run(() =>
    client.exchange.client.getMarketOnchain(params.marketId),
  );
  const id = params.direction === "UP" ? onchain.yesId : onchain.noId;
  return client.queue.run(() =>
    client.exchange.client.getOutcomeBalance({
      outcomeToken: onchain.outcomeToken,
      account: params.account,
      id,
    }),
  );
}

/**
 * Positions for a wallet.
 *
 * `marketIds` is optional. Supply them when you already know which windows the
 * wallet touched (Phase 2's indexer will) — that path is pure chain reads and
 * cannot be broken by an indexer outage. Omit them and the markets are
 * discovered through the indexer first, which is convenient but is exactly the
 * query that failed mid-run in Phase 0 — so its failure raises `API_DOWN` with
 * the explicit path named, rather than quietly returning an empty list that
 * would read as "you have no positions".
 */
export async function getPositions(
  client: DexClient,
  params: { account: `0x${string}`; marketIds?: readonly `0x${string}`[] },
): Promise<Position[]> {
  let marketIds = params.marketIds;

  if (!marketIds) {
    try {
      const claimable = await client.queue.run(() =>
        client.exchange.client.getClaimable(params.account),
      );
      marketIds = [...new Set(claimable.map((c) => c.marketId as `0x${string}`))];
    } catch (e) {
      throw asDexError(e, "API_DOWN");
    }
  }

  const out: Position[] = [];

  for (const marketId of marketIds) {
    const settlement = await getSettlement(client, marketId);
    const onchain = await client.queue.run(() => client.exchange.client.getMarketOnchain(marketId));

    for (const direction of ["UP", "DOWN"] as const) {
      const id = direction === "UP" ? onchain.yesId : onchain.noId;
      const contracts = await client.queue.run(() =>
        client.exchange.client.getOutcomeBalance({
          outcomeToken: onchain.outcomeToken,
          account: params.account,
          id,
        }),
      );
      if (contracts <= 0n) continue;

      const status = statusFor(settlement, direction);
      const claimable =
        status === "WON" ? contracts
        : status === "VOID" ? contracts / 2n
        : 0n;

      out.push({ marketId, direction, contracts, status, settlement, claimable });
    }
  }
  return out;
}

export interface RedeemResult {
  readonly txHash: `0x${string}`;
  readonly marketId: `0x${string}`;
  readonly direction: Direction;
  readonly contracts: bigint;
  /** Measured from the wallet, not estimated. */
  readonly received: bigint;
  readonly explorerUrl: string;
}

/**
 * Redeem one settled position, chain-first.
 *
 * Winnings are CLAIMED, not received: a settled market pays out only when
 * someone asks it to. A wallet that trades all week and never redeems reads
 * near zero while its balance sits across dozens of finalised markets.
 */
export async function redeem(
  client: DexClient,
  params: { marketId: `0x${string}`; account: `0x${string}`; direction: Direction },
): Promise<RedeemResult | null> {
  const onchain = await client.queue.run(() =>
    client.exchange.client.getMarketOnchain(params.marketId),
  );
  if (!onchain.isResolved && !onchain.isVoided) {
    throw new DexError("SETTLEMENT_TIMEOUT", "Market has not settled yet; nothing to redeem.", {
      action: "Wait for settlement, then retry.",
      retryable: true,
    });
  }

  const outcomeIdx = outcomeIndexFor(params.direction);
  const id = params.direction === "UP" ? onchain.yesId : onchain.noId;
  const contracts = await client.queue.run(() =>
    client.exchange.client.getOutcomeBalance({
      outcomeToken: onchain.outcomeToken, account: params.account, id,
    }),
  );
  if (contracts <= 0n) return null;

  const before = await client.queue.run(() =>
    client.rpc.readContract({
      address: client.collateral.address, abi: erc20Abi, functionName: "balanceOf", args: [params.account],
    }),
  );

  const trader = client.exchange.client.createTrader({
    ...(client.config.privateKey ? { privateKey: client.config.privateKey } : {}),
    ...(client.config.walletClient ? { walletClient: client.config.walletClient } : {}),
    ...(client.config.account ? { account: client.config.account } : {}),
    decimals: client.collateral.decimals,
  });

  const res = await trader.redeem({
    marketId: params.marketId,
    amount: contracts,
    outcomeIdx,
    market: onchain.marketAddress,
    outcomeToken: onchain.outcomeToken,
  });

  if (res.receipt.status === "reverted") {
    throw new DexError("ORDER_REJECTED", `Redeem reverted. ${explorerTx(res.hash)}`, {
      action: "Re-check the market settled and the position is still held.",
    });
  }

  const after = await client.queue.run(() =>
    client.rpc.readContract({
      address: client.collateral.address, abi: erc20Abi, functionName: "balanceOf", args: [params.account],
    }),
  );

  return {
    txHash: res.hash,
    marketId: params.marketId,
    direction: params.direction,
    contracts,
    received: after - before,
    explorerUrl: explorerTx(res.hash),
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until a window finalises.
 *
 * Polling is the guarantee; the live feed is only an optimisation (AGENTS.md).
 * A deadline is used rather than a single read because indexer rows lag and a
 * transient RPC error must not be mistaken for "not settled".
 */
export async function awaitSettlement(
  client: DexClient,
  marketId: `0x${string}`,
  opts: { timeoutMs: number; intervalMs?: number; onTick?: (s: Settlement, elapsedMs: number) => void },
): Promise<Settlement> {
  const intervalMs = opts.intervalMs ?? 5_000;
  const startedAt = Date.now();

  for (;;) {
    const elapsed = Date.now() - startedAt;
    let settlement: Settlement | undefined;
    try {
      settlement = await getSettlement(client, marketId);
    } catch {
      if (elapsed > opts.timeoutMs) {
        throw new DexError("SETTLEMENT_TIMEOUT", "Chain reads kept failing while awaiting settlement.", {
          retryable: true,
        });
      }
    }

    if (settlement) {
      opts.onTick?.(settlement, elapsed);
      if (settlement.status !== "PENDING") return settlement;
    }

    if (elapsed > opts.timeoutMs) {
      throw new DexError(
        "SETTLEMENT_TIMEOUT",
        `Window did not finalise within ${Math.round(opts.timeoutMs / 1000)}s.`,
        {
          action: "Settlement is normally seconds after expiry. The position is unaffected; poll again.",
          retryable: true,
        },
      );
    }
    await sleep(intervalMs);
  }
}

export { MarketStatus };
