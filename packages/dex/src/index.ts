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

export { DexError, asDexError, type DexErrorCode, type DexErrorOptions } from "./errors.js";

export {
  TESTNET_CHAIN_ID, MAINNET_CHAIN_ID, ELWOOD_CHAIN_ID, MAINNET_HOSTS, MAINNET_COLLATERAL,
  COLLATERAL_DECIMALS, COLLATERAL_SYMBOL, GAS_CEILING_WEI, SHANNON, TESTNET_ADDRESSES,
  LINKS, explorerTx, explorerAddress, assertTestnetConfig,
} from "./config.js";

export { createDexClient, assertLiveNetwork, type DexClient, type DexConfig } from "./client.js";

export {
  parseAmount, formatAmount, formatFixed, priceToPercent, probabilityToPrice,
  quantizeDown, quantizeUp, formatStt, NATIVE_DECIMALS, MoneyError,
} from "./money.js";

export { RequestQueue, type QueueOptions } from "./queue.js";
export { ServerClock, type ClockSource } from "./time.js";

export { getMarkets, invalidateMarkets, type MarketsInfo, type VenueInfo } from "./markets.js";

export {
  getWindows, getCurrentWindow, headroomSecFor, MarketStatus,
  outcomeIndexFor, directionFor,
  type Window, type Direction, type GetWindowsOptions,
} from "./windows.js";

export {
  quoteCall, preflightCall, prepareCall, placeCall, idempotencyKey,
  ORDER_TYPE_REST, ORDER_TYPE_FILL_OR_KILL, ORDER_TYPE_IOC, ORDER_TYPE_POST_ONLY,
  type Quote, type Preflight, type CallRequest, type PreparedCall, type PlacedCall,
} from "./orders.js";

export {
  getSettlement, getPositions, getOutcomeBalance, redeem, awaitSettlement, statusFor,
  type Settlement, type Position, type PositionStatus, type RedeemResult,
} from "./positions.js";

export { subscribe, type Subscription, type SubscribeOptions, type SubscriptionStatus } from "./subscribe.js";
