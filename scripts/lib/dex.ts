/**
 * The one place that talks to DreamDEX (AGENTS.md §8 / CLAUDE.md rule 4).
 *
 * Phase 1 promotes this into `packages/dex`. Kept deliberately thin: it owns
 * client construction, the runtime identity assertions, market selection, and
 * the settlement poll — the pieces every Phase 0 script would otherwise
 * reimplement slightly differently.
 */
import { SomniaMarkets, quoteBinaryStakeOverBook } from "@somnia-chain/markets-sdk";
import type { BinaryMarket, MarketOnchain, BinaryStakeQuote, BinaryBuySide } from "@somnia-chain/markets-sdk";
import { createPublicClient, http, erc20Abi, type PublicClient } from "viem";
import { loadConfig, type AppConfig, MAINNET_CHAIN_ID, MAINNET_COLLATERAL, ConfigError } from "./config.js";

/** Machine codes the UI will switch on. Mirrors CLAUDE.md's error pattern. */
export type DexErrorCode =
  | "WINDOW_CLOSED"
  | "INSUFFICIENT_STAKE"
  | "INSUFFICIENT_GAS"
  | "NEEDS_APPROVAL"
  | "ORDER_REJECTED"
  | "NO_LIQUIDITY"
  | "NO_MARKETS"
  | "RATE_LIMITED"
  | "API_DOWN"
  | "CHAIN_MISMATCH"
  | "MAINNET_FORBIDDEN"
  | "SETTLEMENT_TIMEOUT"
  | "UNKNOWN";

export class DexError extends Error {
  readonly code: DexErrorCode;
  readonly action: string | undefined;
  constructor(code: DexErrorCode, message: string, action?: string) {
    super(message);
    this.name = "DexError";
    this.code = code;
    this.action = action;
  }
}

export interface Dex {
  readonly cfg: AppConfig;
  readonly exchange: SomniaMarkets;
  readonly rpc: PublicClient;
  close(): void;
}

/**
 * Builds the SDK client. `privateKey` is optional so every read-only tool runs
 * before any wallet exists — a missing key is a normal pre-funding state.
 */
export function createDex(privateKey?: `0x${string}`): Dex {
  const cfg = loadConfig();

  const exchange = new SomniaMarkets({
    indexerUrl: cfg.indexerUrl,
    chain: cfg.chain,
    wsRpcUrl: cfg.rpcWsUrl,
    addresses: cfg.addresses,
    ...(privateKey ? { privateKey } : {}),
  });

  const rpc = createPublicClient({
    chain: cfg.chain,
    transport: http(cfg.rpcHttpUrl, { timeout: 20_000, retryCount: 2 }),
  }) as PublicClient;

  return {
    cfg,
    exchange,
    rpc,
    close() {
      try {
        exchange.client.stopLive();
      } catch {
        /* nothing live to stop */
      }
    },
  };
}

/**
 * Build the client, or fail with an actionable message instead of a stack trace.
 *
 * `createDex()` throws on a bad or mainnet-pointing config. Every entry point
 * was calling it outside its try block, so a `ConfigError` escaped as an
 * unhandled rejection and printed raw Node output — the "generic failure" that
 * CLAUDE.md's error pattern exists to prevent.
 */
export function createDexOrExit(privateKey?: `0x${string}`): Dex {
  try {
    return createDex(privateKey);
  } catch (e) {
    const known = e instanceof ConfigError || e instanceof DexError;
    const code = known ? (e as ConfigError | DexError).code : "UNKNOWN";
    const action = e instanceof DexError ? e.action : undefined;
    console.error(`\n\u001b[31m\u2718 Cannot start: ${code}\u001b[0m`);
    console.error(`  ${e instanceof Error ? e.message : String(e)}`);
    console.error(`  \u001b[33m\u2192\u001b[0m ${action ?? "Fix .env (see .env.example) and re-run."}\n`);
    process.exit(1);
  }
}

/**
 * Runtime identity assertions. Addresses cannot distinguish the networks (8 of
 * 11 are byte-identical via CREATE3), so the chain id and the collateral token
 * are the guard — checked against the live chain, not against config.
 */
export async function assertLiveTestnet(dex: Dex): Promise<{ chainId: number; collateralSymbol: string; collateralDecimals: number }> {
  const chainId = await dex.rpc.getChainId();
  if (chainId === MAINNET_CHAIN_ID) {
    throw new DexError(
      "MAINNET_FORBIDDEN",
      `RPC ${dex.cfg.rpcHttpUrl} is Somnia MAINNET (${chainId}). Refusing to continue.`,
      "Point RPC_HTTP_URL at https://dream-rpc.somnia.network.",
    );
  }
  if (chainId !== dex.cfg.chainId) {
    throw new DexError(
      "CHAIN_MISMATCH",
      `RPC reports chain ${chainId}, expected Shannon ${dex.cfg.chainId}.`,
      "Check RPC_HTTP_URL — 50313 is Elwood, a different Somnia testnet.",
    );
  }

  const collateral = dex.cfg.collateral.address;
  if (!collateral) throw new DexError("UNKNOWN", "SDK exposed no testnet collateral address.");
  if (collateral.toLowerCase() === MAINNET_COLLATERAL) {
    throw new DexError("MAINNET_FORBIDDEN", "Collateral is the mainnet USDso address.");
  }

  const [symbol, decimals] = await Promise.all([
    dex.rpc.readContract({ address: collateral, abi: erc20Abi, functionName: "symbol" }),
    dex.rpc.readContract({ address: collateral, abi: erc20Abi, functionName: "decimals" }),
  ]);

  if (decimals !== dex.cfg.collateral.decimals) {
    throw new DexError(
      "UNKNOWN",
      `Collateral decimals changed: chain says ${decimals}, config assumes ${dex.cfg.collateral.decimals}. ` +
        `All money math depends on this — stop and re-check docs/dex-notes.md §2.`,
    );
  }
  return { chainId, collateralSymbol: symbol, collateralDecimals: decimals };
}

export interface WindowCandidate {
  readonly market: BinaryMarket;
  readonly onchain: MarketOnchain;
  readonly secondsLeft: number;
}

/** On-chain status 1 = Trading. Only a Trading market accepts orders. */
export const STATUS_TRADING = 1;

/**
 * Expiry headroom, scaled to the series rather than fixed. A flat 300s
 * threshold rejects every market on a 60s or 300s venue; too little headroom
 * and the window locks between snapshot and send (docs/dex-notes.md §8.8).
 */
export function headroomSecFor(intervalSec: number): number {
  return Math.max(5, Math.min(60, Math.ceil(intervalSec * 0.15)));
}

/**
 * Live windows for an asset, gated on ON-CHAIN status rather than the indexer's
 * — the indexer lags the chain by seconds and will happily offer a market that
 * has already locked (docs/dex-notes.md §8.1).
 */
export async function findTradableWindows(
  dex: Dex,
  opts: { asset: string; intervalSec?: number | undefined; limit?: number },
): Promise<WindowCandidate[]> {
  const { asset, intervalSec } = opts;
  const limit = opts.limit ?? 50;

  let markets: BinaryMarket[];
  try {
    markets = await dex.exchange.client.listLiveBinaryMarkets({
      asset,
      ...(intervalSec !== undefined ? { intervalSec } : {}),
      orderBy: "closingSoon",
      limit,
    });
  } catch (e) {
    throw new DexError(
      "API_DOWN",
      `Indexer query failed: ${e instanceof Error ? e.message : String(e)}`,
      `Check INDEXER_URL (${dex.cfg.indexerUrl}) is reachable.`,
    );
  }

  const nowSec = Date.now() / 1000;
  const out: WindowCandidate[] = [];

  for (const market of markets) {
    const secondsLeft = Number(market.expiry) - nowSec;
    if (secondsLeft <= 0) continue;

    const interval = Number(market.intervalSec ?? intervalSec ?? 0);
    if (interval > 0 && secondsLeft < headroomSecFor(interval)) continue;

    let onchain: MarketOnchain;
    try {
      onchain = await dex.exchange.client.getMarketOnchain(market.marketId);
    } catch {
      continue; // a market we cannot read on-chain is a market we must not trade
    }
    if (onchain.status !== STATUS_TRADING) continue;

    out.push({ market, onchain, secondsLeft });
  }

  out.sort((a, b) => a.secondsLeft - b.secondsLeft);
  return out;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface SettlementOutcome {
  readonly status: "RESOLVED" | "VOIDED";
  readonly winningOutcome: number | null;
  readonly onchain: MarketOnchain;
}

/**
 * Polls the chain until a market finalises. Polling is the guarantee; the live
 * WS feed is only ever an optimisation (AGENTS.md §5). Uses a deadline rather
 * than trusting a single read because indexer rows lag the chain.
 */
export async function awaitSettlement(
  dex: Dex,
  marketId: `0x${string}`,
  opts: { timeoutMs: number; intervalMs?: number; onTick?: (o: MarketOnchain, elapsedMs: number) => void },
): Promise<SettlementOutcome> {
  const intervalMs = opts.intervalMs ?? 5_000;
  const startedAt = Date.now();

  for (;;) {
    const elapsed = Date.now() - startedAt;
    let onchain: MarketOnchain;
    try {
      onchain = await dex.exchange.client.getMarketOnchain(marketId);
    } catch {
      if (elapsed > opts.timeoutMs) {
        throw new DexError("SETTLEMENT_TIMEOUT", "Chain reads kept failing while awaiting settlement.");
      }
      await sleep(intervalMs);
      continue;
    }

    opts.onTick?.(onchain, elapsed);

    if (onchain.isVoided) return { status: "VOIDED", winningOutcome: null, onchain };
    if (onchain.isResolved) {
      return { status: "RESOLVED", winningOutcome: onchain.winningOutcome, onchain };
    }

    if (elapsed > opts.timeoutMs) {
      throw new DexError(
        "SETTLEMENT_TIMEOUT",
        `Market did not finalise within ${Math.round(opts.timeoutMs / 1000)}s of the deadline.`,
        "Settlement is usually seconds after expiry. Re-run to keep polling; the position is unaffected.",
      );
    }
    await sleep(intervalMs);
  }
}

/**
 * Quote a stake against the CHAIN's order book.
 *
 * `client.quoteBinaryStake()` looks like the obvious call and is a trap: it
 * reads the SDK's reactive store via `resolveLiveBinaryBook`, which is empty
 * unless a live tail is running. With no subscription it returns `null` — not
 * an error, just "no liquidity" — even while `getBinaryOrderBook()` shows a
 * full book one eth_call away. Measured: every quote returned null against
 * windows quoting 0.355/0.673.
 *
 * So we read the book from chain and run the SDK's own exported pure quoting
 * function over it. Same math, and the chain stays the source of truth — which
 * is what our own rule about not trusting the indexer already demanded.
 */
export async function quoteStakeOnChain(
  dex: Dex,
  pool: `0x${string}`,
  side: BinaryBuySide,
  stake: bigint,
  depth = 10,
): Promise<BinaryStakeQuote | null> {
  const [book, grid] = await Promise.all([
    dex.exchange.client.getBinaryOrderBook(pool, { depth }),
    dex.exchange.client.getBinaryBookParams(pool),
  ]);
  const oneCollateral = 10n ** BigInt(dex.cfg.collateral.decimals);
  return quoteBinaryStakeOverBook(book, side, stake, oneCollateral, {
    tickSize: grid.tickSize,
    lotSize: grid.lotSize,
  });
}
