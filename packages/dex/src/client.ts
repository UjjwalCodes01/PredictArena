/**
 * Client construction. The single seam between this package and DreamDEX.
 *
 * Takes explicit config rather than reading env: a library that reads
 * `process.env` cannot run in a browser, and Phase 3 signs in the browser.
 */
import { SomniaMarkets } from "@somnia-chain/markets-sdk";
import { createPublicClient, http, erc20Abi } from "viem";
import type { PublicClient, WalletClient, Account } from "viem";
import {
  SHANNON, TESTNET_ADDRESSES, TESTNET_CHAIN_ID, MAINNET_CHAIN_ID, MAINNET_COLLATERAL,
  EXPECTED_COLLATERAL_DECIMALS, EXPECTED_COLLATERAL_SYMBOL, ELWOOD_CHAIN_ID, assertTestnetConfig,
} from "./config.js";
import { DexError, asDexError } from "./errors.js";
import { RequestQueue, type QueueOptions } from "./queue.js";
import { ServerClock } from "./time.js";

export interface DexConfig {
  /** Envio/Hasura GraphQL endpoint serving Shannon binary markets. */
  indexerUrl: string;
  rpcHttpUrl: string;
  rpcWsUrl?: string;
  /** Defaults to 50312. Anything else is rejected. */
  chainId?: number;
  /** Server/CLI signing. Never in a browser. */
  privateKey?: `0x${string}`;
  /** Browser signing (wagmi/injected). Preferred for the web app. */
  walletClient?: WalletClient;
  account?: Account | `0x${string}`;
  queue?: QueueOptions;
  /** How long `getMarkets()` caches for. Default 60s. */
  marketsTtlMs?: number;
}

export interface DexClient {
  readonly config: Required<Pick<DexConfig, "indexerUrl" | "rpcHttpUrl" | "chainId">> & DexConfig;
  readonly exchange: SomniaMarkets;
  readonly rpc: PublicClient;
  readonly queue: RequestQueue;
  readonly clock: ServerClock;
  /**
   * Symbol and decimals are the EXPECTED values until `assertLiveNetwork()`
   * runs; after it, they are what the token contract actually reports. Read
   * them for display only once `verified` is true.
   */
  readonly collateral: { address: `0x${string}`; symbol: string; decimals: number };
  /** True once `assertLiveNetwork` has confirmed the chain and collateral. */
  readonly verified: boolean;
  close(): void;
}

interface MutableDexClient extends Omit<DexClient, "verified" | "collateral"> {
  verified: boolean;
  collateral: { address: `0x${string}`; symbol: string; decimals: number };
}

export function createDexClient(config: DexConfig): DexClient {
  const chainId = config.chainId ?? TESTNET_CHAIN_ID;
  assertTestnetConfig({ chainId, urls: [config.indexerUrl, config.rpcHttpUrl, config.rpcWsUrl] });

  const collateralAddress = TESTNET_ADDRESSES.collateral as `0x${string}` | undefined;
  if (!collateralAddress) {
    throw new DexError("UNKNOWN", "The SDK exposed no testnet collateral address.", {
      action: "Upgrade @somnia-chain/markets-sdk.",
    });
  }
  if (collateralAddress.toLowerCase() === MAINNET_COLLATERAL) {
    throw new DexError("MAINNET_FORBIDDEN", "Collateral resolved to the mainnet USDso address.");
  }

  const exchange = new SomniaMarkets({
    indexerUrl: config.indexerUrl,
    chain: SHANNON,
    ...(config.rpcWsUrl ? { wsRpcUrl: config.rpcWsUrl } : {}),
    addresses: TESTNET_ADDRESSES,
    ...(config.privateKey ? { privateKey: config.privateKey } : {}),
    ...(config.walletClient ? { walletClient: config.walletClient } : {}),
    ...(config.account ? { account: config.account } : {}),
  });

  const rpc = createPublicClient({
    chain: SHANNON,
    transport: http(config.rpcHttpUrl, { timeout: 20_000, retryCount: 2 }),
  }) as PublicClient;

  const queue = new RequestQueue(config.queue);

  const clock = new ServerClock({
    fetchChainTimeSec: async () => {
      const block = await rpc.getBlock();
      return Number(block.timestamp);
    },
    nowMs: () => Date.now(),
  });

  const client: MutableDexClient = {
    config: { ...config, chainId, indexerUrl: config.indexerUrl, rpcHttpUrl: config.rpcHttpUrl },
    exchange,
    rpc,
    queue,
    clock,
    collateral: {
      address: collateralAddress,
      symbol: EXPECTED_COLLATERAL_SYMBOL,
      decimals: EXPECTED_COLLATERAL_DECIMALS,
    },
    verified: false,
    close() {
      try {
        exchange.client.stopLive();
      } catch {
        /* nothing live to stop */
      }
    },
  };

  return client as DexClient;
}

/**
 * Confirms against the LIVE chain that we are on Shannon and that the collateral
 * is the token our money math assumes. Config can lie; the chain cannot.
 *
 * Call once at startup. Everything that spends money should refuse to run until
 * this has passed.
 */
export async function assertLiveNetwork(client: DexClient): Promise<{
  chainId: number;
  collateralSymbol: string;
  collateralDecimals: number;
}> {
  const mutable = client as MutableDexClient;
  let chainId: number;
  try {
    chainId = await client.queue.run(() => client.rpc.getChainId());
  } catch (e) {
    throw asDexError(e, "API_DOWN");
  }

  if (chainId === MAINNET_CHAIN_ID) {
    throw new DexError("MAINNET_FORBIDDEN", `RPC ${client.config.rpcHttpUrl} is Somnia MAINNET.`, {
      action: "Point rpcHttpUrl at https://dream-rpc.somnia.network.",
    });
  }
  if (chainId !== client.config.chainId) {
    throw new DexError("CHAIN_MISMATCH", `RPC reports chain ${chainId}, expected ${client.config.chainId}.`, {
      action: chainId === ELWOOD_CHAIN_ID ? "That is Elwood, not Shannon." : "Check rpcHttpUrl.",
    });
  }

  const [symbol, decimals] = await client.queue.run(() =>
    Promise.all([
      client.rpc.readContract({ address: client.collateral.address, abi: erc20Abi, functionName: "symbol" }),
      client.rpc.readContract({ address: client.collateral.address, abi: erc20Abi, functionName: "decimals" }),
    ]),
  );

  if (decimals !== EXPECTED_COLLATERAL_DECIMALS) {
    throw new DexError(
      "UNKNOWN",
      `Collateral decimals changed: chain says ${decimals}, this package expects ${EXPECTED_COLLATERAL_DECIMALS}.`,
      { action: "Every money path depends on this. Stop and re-verify docs/dex-notes.md §2." },
    );
  }
  // The symbol is an identity check, not decoration: the address is baked into
  // the SDK at ITS release, so a different token sitting there means the
  // deployment moved under us. Displaying a label the chain never confirmed
  // would be showing the user something false.
  if (symbol !== EXPECTED_COLLATERAL_SYMBOL) {
    throw new DexError(
      "UNKNOWN",
      `Collateral at ${client.collateral.address} reports "${symbol}", expected "${EXPECTED_COLLATERAL_SYMBOL}".`,
      { action: "The collateral deployment changed. Re-verify addresses before trading." },
    );
  }

  // From here on, what we display is what the chain said.
  mutable.collateral = { ...client.collateral, symbol, decimals };
  await client.clock.sync();
  mutable.verified = true;
  return { chainId, collateralSymbol: symbol, collateralDecimals: decimals };
}
