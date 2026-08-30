/**
 * `@predictarena/dex` — the ONLY module allowed to talk to DreamDEX.
 *
 * The web app and the indexer import this; neither may reach the network
 * directly (CLAUDE.md hard rule 4). Everything onchain is a `bigint`;
 * formatting belongs to display code.
 *
 * Quick start:
 * ```ts
 * const dex = createDexClient({ indexerUrl, rpcHttpUrl, privateKey });
 * await assertLiveNetwork(dex);                 // chain + collateral identity
 * const window = await getCurrentWindow(dex, { asset: "BTC", intervalSec: 300 });
 * const placed = await placeCall(dex, { window, direction: "UP", stake, account });
 * const settled = await awaitSettlement(dex, window.marketId, { timeoutMs });
 * await redeem(dex, { marketId: window.marketId, account, direction: "UP" });
 * ```
 */

export { DexError, asDexError, type DexErrorCode, type DexErrorOptions } from "./errors";

export {
  TESTNET_CHAIN_ID, MAINNET_CHAIN_ID, ELWOOD_CHAIN_ID, MAINNET_HOSTS, MAINNET_COLLATERAL,
  EXPECTED_COLLATERAL_DECIMALS, EXPECTED_COLLATERAL_SYMBOL, GAS_CEILING_WEI, SDK_DEFAULT_GAS,
  SHANNON, TESTNET_ADDRESSES,
  LINKS, explorerTx, explorerAddress, assertTestnetConfig,
} from "./config";

export { createDexClient, assertLiveNetwork, type DexClient, type DexConfig } from "./client";

export {
  parseAmount, formatAmount, formatFixed, priceToPercent, probabilityToPrice,
  quantizeDown, quantizeUp, formatStt, NATIVE_DECIMALS, MoneyError,
} from "./money";

export { RequestQueue, type QueueOptions } from "./queue";
export { ServerClock, type ClockSource } from "./time";

export { getMarkets, invalidateMarkets, type MarketsInfo, type VenueInfo } from "./markets";

export {
  getWindows, getWindow, getCurrentWindow, headroomSecFor, MarketStatus,
  outcomeIndexFor, directionFor,
  type Window, type Direction, type GetWindowsOptions,
} from "./windows";

export {
  quoteCall, getTopOfBook, preflightCall, prepareCall, placeCall, idempotencyKey,
  ORDER_TYPE_REST, ORDER_TYPE_FILL_OR_KILL, ORDER_TYPE_IOC, ORDER_TYPE_POST_ONLY,
  type Quote, type TopOfBook, type Preflight, type CallRequest, type PreparedCall, type PlacedCall,
} from "./orders";

export {
  getSettlement, getPositions, getOutcomeBalance, redeem, awaitSettlement, statusFor,
  type Settlement, type Position, type PositionStatus, type RedeemResult,
} from "./positions";

export { subscribe, type Subscription, type SubscribeOptions, type SubscriptionStatus } from "./subscribe";
