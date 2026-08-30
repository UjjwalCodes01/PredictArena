/**
 * Placing a call.
 *
 * States and edge cases handled here are enumerated in docs/phase1-design.md;
 * every one is detected BEFORE a signature is requested, except the two that
 * are only knowable after submission (revert, and a fill of zero).
 *
 * Three behaviours exist because Phase 0 measured them, not from caution:
 *
 *  1. `client.quoteBinaryStake()` reads the SDK's reactive store, which is empty
 *     unless a live tail is running — it returns `null`, indistinguishable from
 *     "no liquidity", while the chain shows a full book. We read the book from
 *     chain and run the SDK's exported pure quoter over it.
 *  2. A reverted write does NOT throw. The receipt rides on the result and must
 *     be inspected, or a failed order becomes a phantom pending row forever.
 *  3. Takers pay the fill price, not the price they offered. So a quote is an
 *     estimate and the confirmed cost only exists after the fill.
 */
import { quoteBinaryStakeOverBook } from "@somnia-chain/markets-sdk";
import type {
  BinaryBuySide, PlaceOrderResult, UnsignedOrder, UnsignedCall,
} from "@somnia-chain/markets-sdk";
import { erc20Abi, keccak256, encodePacked, encodeFunctionData } from "viem";
import type { DexClient } from "./client";
import { GAS_CEILING_WEI, LINKS, explorerTx } from "./config";
import { DexError, asDexError } from "./errors";
import { formatFixed } from "./money";
import { MarketStatus, headroomSecFor, type Direction, type Window } from "./windows";

const sideFor = (direction: Direction): BinaryBuySide => (direction === "UP" ? "BUY_YES" : "BUY_NO");

/**
 * OrderBook order types. The SDK's exported `ORDER_TYPE` names value 2 "MARKET"
 * while the contract docs call it ImmediateOrCancel; they are the same thing —
 * an IOC placed at the price extreme. Named here so the intent is unambiguous.
 */
export const ORDER_TYPE_REST = 0;
export const ORDER_TYPE_FILL_OR_KILL = 1;
export const ORDER_TYPE_IOC = 2;
export const ORDER_TYPE_POST_ONLY = 3;

export interface Quote {
  readonly direction: Direction;
  readonly side: BinaryBuySide;
  /** Protective limit price, tick-aligned, in collateral base units. */
  readonly limitPrice: bigint;
  /** Best price currently resting, in Up terms. */
  readonly yesPrice: bigint;
  /** Contracts, lot-aligned. */
  readonly quantity: bigint;
  /** Collateral locked. May be slightly under the requested stake after lot alignment. */
  readonly escrow: bigint;
  /** A winning contract redeems for exactly 1 collateral unit. */
  readonly maxPayout: bigint;
}

/**
 * Price a stake against the CHAIN's book. Returns `null` only when there is
 * genuinely nothing to fill against.
 */
export async function quoteCall(
  client: DexClient,
  params: { window: Window; direction: Direction; stake: bigint },
): Promise<Quote | null> {
  const { window, direction, stake } = params;
  if (stake <= 0n) throw new DexError("INSUFFICIENT_STAKE", "Stake must be positive.");

  const [book, grid] = await client.queue.run(() =>
    Promise.all([
      client.exchange.client.getBinaryOrderBook(window.pool, { depth: 10 }),
      client.exchange.client.getBinaryBookParams(window.pool),
    ]),
  );

  const oneCollateral = 10n ** BigInt(client.collateral.decimals);
  const quote = quoteBinaryStakeOverBook(book, sideFor(direction), stake, oneCollateral, {
    tickSize: grid.tickSize,
    lotSize: grid.lotSize,
  });
  if (!quote || quote.quantity <= 0n) return null;

  if (quote.quantity < grid.minQuantity) {
    throw new DexError(
      "INSUFFICIENT_STAKE",
      `Stake buys ${formatFixed(quote.quantity, client.collateral.decimals, 4)} contracts, ` +
        `below the venue minimum of ${formatFixed(grid.minQuantity, client.collateral.decimals, 4)}.`,
      { action: "Increase the stake." },
    );
  }

  return {
    direction,
    side: quote.side,
    limitPrice: quote.limitPrice,
    yesPrice: quote.yesPrice,
    quantity: quote.quantity,
    escrow: quote.escrow,
    // Every winning contract redeems for exactly one unit of collateral.
    maxPayout: quote.quantity,
  };
}

/** Best available cost per contract on each side. Null when a side is empty. */
export interface TopOfBook {
  readonly up: bigint | null;
  readonly down: bigint | null;
}

/**
 * Cheapest ask on each outcome, read from the chain's book.
 *
 * The feed needs a price per window without pricing a specific stake, and this
 * is one read rather than two quotes. Exposed here so the web app never has to
 * reach past this package to the SDK (CLAUDE.md rule 4).
 */
export async function getTopOfBook(client: DexClient, pool: `0x${string}`): Promise<TopOfBook> {
  const book = await client.queue.run(() =>
    client.exchange.client.getBinaryOrderBook(pool, { depth: 1 }),
  );
  return {
    up: book.yesAsks?.[0]?.price ?? null,
    down: book.noAsks?.[0]?.price ?? null,
  };
}

/**
 * Did this revert mean "nothing to fill against"?
 *
 * An IOC order that finds no depth reverts with ImmediateOrCancel, and it is
 * COMMON: the ask side on a heavy favourite is often empty, because nobody
 * sells a near-certainty. Live testing hit it five times consecutively at
 * 80-83% implied.
 *
 * Exported so the behaviour is testable rather than buried in a catch block.
 */
export function isUnfillable(e: unknown): boolean {
  return /immediateorcancel|\bioc\b/i.test(String(e));
}

/**
 * Mint test collateral to the connected wallet.
 *
 * The testnet tUSDC contract exposes a public `faucet(uint256)`, so any wallet
 * holding STT for gas can mint its own stake. Before this existed in the app, a
 * player who had claimed STT from the web faucet still had nothing to bet with,
 * and the interface sent them BACK to that same faucet -- which does not issue
 * tUSDC. That was a dead end sitting directly in the onboarding path.
 *
 * Testnet only, by construction: this function does not exist on a real
 * collateral token, so there is nothing here that could work against real money.
 */
export async function mintCollateral(
  client: DexClient,
  amountWhole = 100n,
): Promise<{ txHash: `0x${string}`; minted: bigint }> {
  const decimals = client.collateral.decimals;
  const amount = amountWhole * 10n ** BigInt(decimals);

  const trader = client.exchange.client.createTrader({
    ...(client.config.privateKey ? { privateKey: client.config.privateKey } : {}),
    ...(client.config.walletClient ? { walletClient: client.config.walletClient } : {}),
    ...(client.config.account ? { account: client.config.account } : {}),
    decimals,
  });

  try {
    const res = await trader.faucet({ amount });
    // A reverted faucet resolves rather than throwing, same as an order.
    if (res.receipt?.status === "reverted") {
      throw new DexError("ORDER_REJECTED", "The faucet refused that request.", {
        action: "It is rate-limited per address. Try again in a few minutes.",
        retryable: true,
      });
    }
    return { txHash: res.hash, minted: amount };
  } catch (e) {
    if (e instanceof DexError) throw e;
    throw asDexError(e, "ORDER_REJECTED");
  }
}

export interface Balances {
  readonly stt: bigint;
  readonly collateral: bigint;
  readonly allowance: bigint;
  /** True when STT covers the funded gas ceiling, not merely when it is above zero. */
  readonly canPayGas: boolean;
}

/**
 * Balances for DISPLAY. Never throws on a shortfall.
 *
 * `preflightCall` deliberately throws so a call cannot be signed against an
 * empty wallet. That is the wrong shape for showing someone what they hold
 * BEFORE they choose a stake -- an exception is not a balance. This reads the
 * same three values and reports them plainly.
 *
 * `allowance` is per-pool, so it is only meaningful with a window in hand;
 * omit the pool and it comes back as zero.
 */
export async function getBalances(
  client: DexClient,
  account: `0x${string}`,
  pool?: `0x${string}`,
): Promise<Balances> {
  const [stt, collateral, allowance] = await client.queue.run(() =>
    Promise.all([
      client.rpc.getBalance({ address: account }),
      client.rpc.readContract({
        address: client.collateral.address, abi: erc20Abi, functionName: "balanceOf", args: [account],
      }),
      pool
        ? client.rpc.readContract({
            address: client.collateral.address, abi: erc20Abi, functionName: "allowance", args: [account, pool],
          })
        : Promise.resolve(0n),
    ]),
  );
  return { stt, collateral, allowance, canPayGas: stt >= GAS_CEILING_WEI };
}

export interface Preflight {
  readonly sttBalance: bigint;
  readonly collateralBalance: bigint;
  readonly allowance: bigint;
  readonly needsApproval: boolean;
  readonly spender: `0x${string}`;
}

/**
 * Everything checkable before a signature is requested. Throws the specific
 * code — never a generic failure — so the UI can show a faucet link for a
 * balance problem and a network switch for a chain problem.
 */
export async function preflightCall(
  client: DexClient,
  params: { window: Window; quote: Quote; account: `0x${string}`; autoApprove?: boolean },
): Promise<Preflight> {
  const { window, quote, account } = params;

  if (window.onchain.status !== MarketStatus.Trading) {
    throw new DexError("WINDOW_CLOSED", `Window is not trading (status ${window.onchain.status}).`, {
      action: "Roll to the next window.",
    });
  }
  const needed = headroomSecFor(window.intervalSec ?? 0);
  if (window.secondsLeft < needed) {
    throw new DexError(
      "WINDOW_CLOSED",
      `Only ${Math.round(window.secondsLeft)}s left; an order needs ~${needed}s to be worth sending.`,
      { action: "Roll to the next window." },
    );
  }

  const [stt, balance, allowance] = await client.queue.run(() =>
    Promise.all([
      client.rpc.getBalance({ address: account }),
      client.rpc.readContract({
        address: client.collateral.address, abi: erc20Abi, functionName: "balanceOf", args: [account],
      }),
      client.rpc.readContract({
        address: client.collateral.address, abi: erc20Abi, functionName: "allowance", args: [account, window.pool],
      }),
    ]),
  );

  const d = client.collateral.decimals;

  // Gas is checked against the funded ceiling, not against zero: the mempool
  // refuses a transaction whose 10M-gas ceiling is not covered.
  if (stt < GAS_CEILING_WEI) {
    throw new DexError(
      "INSUFFICIENT_GAS",
      stt === 0n ? "No STT for gas." : `Only ${formatFixed(stt, 18, 4)} STT; ~0.6 is needed to fund the gas ceiling.`,
      { action: `Get STT from the faucet: ${LINKS.faucet}` },
    );
  }
  if (balance < quote.escrow) {
    throw new DexError(
      "INSUFFICIENT_STAKE",
      `Need ${formatFixed(quote.escrow, d, 4)} ${client.collateral.symbol}, wallet holds ${formatFixed(balance, d, 4)}.`,
      { action: `Get ${client.collateral.symbol} from the faucet: ${LINKS.faucet}` },
    );
  }

  const needsApproval = allowance < quote.escrow;

  // With auto-approve on (the default) the SDK bundles the approval, so a short
  // allowance is not an error. A browser flow usually wants the opposite: the
  // user should see an explicit "Approve" step rather than an unexplained second
  // wallet prompt (AGENTS.md §5). Passing `autoApprove: false` asks for that,
  // and this is where it surfaces.
  if (needsApproval && params.autoApprove === false) {
    throw new DexError(
      "NEEDS_APPROVAL",
      `Allowance ${formatFixed(allowance, d, 4)} is below the ${formatFixed(quote.escrow, d, 4)} escrow.`,
      { action: `Approve ${client.collateral.symbol} for the pool, then place the call.` },
    );
  }

  return {
    sttBalance: stt,
    collateralBalance: balance,
    allowance,
    needsApproval,
    spender: window.pool,
  };
}

/**
 * Idempotency key, carried on the order itself via `userData` — the client
 * order id AGENTS.md §5 asks for. Deterministic per (wallet, window), so a
 * double-tap is identifiable on-chain rather than becoming a second position.
 */
export function idempotencyKey(wallet: `0x${string}`, marketId: `0x${string}`): bigint {
  return BigInt(keccak256(encodePacked(["address", "bytes32"], [wallet, marketId]))) & ((1n << 64n) - 1n);
}

export interface CallRequest {
  window: Window;
  direction: Direction;
  /** Collateral base units (tUSDC, 6dp) — NOT wei. */
  stake: bigint;
  account: `0x${string}`;
  /**
   * IOC by default: it fills what the book offers and cancels the rest. FOK is
   * all-or-nothing, which turns a thin book into a hard failure — and liquidity
   * gaps at every window roll are a measured reality, not a hypothetical.
   */
  orderType?: number;
  /**
   * Default true: the SDK bundles an approval when the allowance is short. Set
   * false to require an explicit approve step instead — preflight then throws
   * `NEEDS_APPROVAL` rather than approving behind the user's back.
   */
  autoApprove?: boolean;
}

export interface PreparedCall {
  readonly quote: Quote;
  readonly preflight: Preflight;
  /** Send first if present. `NEEDS_APPROVAL` as a pre-step, not an error. */
  readonly approval: UnsignedOrder["approval"] | undefined;
  readonly order: UnsignedOrder["order"];
  readonly idempotencyKey: bigint;
  readonly expiresAtSec: number;
}

/**
 * Build the transactions for CLIENT-SIDE signing without sending anything.
 * This is the path the web app uses: the server never holds a user key.
 */
/**
 * An ERC-20 approval for EXACTLY what this call needs.
 *
 * The SDK's own approval is for `maxUint256` -- an unlimited allowance. That is
 * convenient (approve once, trade forever) and it is also the single clearest
 * signature of a wallet drainer, which is why wallet security scanners flag any
 * site that requests one. A brand-new domain asking for infinite spending
 * authority is indistinguishable, to a scanner, from an actual attack.
 *
 * It is also simply worse for the user. An unlimited allowance means the pool
 * can move every tUSDC the wallet will ever hold, forever, on the strength of
 * one signature. Approving the escrow means the worst case is this one call.
 *
 * The cost is an approval per call rather than one ever. On a testnet game with
 * one-tUSDC stakes that is a fair trade for not being flagged as a drainer.
 */
export function buildExactApproval(
  client: DexClient,
  spender: `0x${string}`,
  amount: bigint,
): UnsignedCall {
  const symbol = client.collateral.symbol;
  return {
    to: client.collateral.address,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, amount],
    }),
    value: 0n,
    // The wallet shows this string on the confirmation, so it names the amount
    // rather than saying "approve" and leaving the user to read hex.
    description: `Approve ${formatFixed(amount, client.collateral.decimals, 4)} ${symbol} for this call`,
  };
}

export async function prepareCall(client: DexClient, req: CallRequest): Promise<PreparedCall> {
  const quote = await quoteCall(client, req);
  if (!quote) {
    throw new DexError("NO_LIQUIDITY", `No resting asks on the ${req.direction} side of this window.`, {
      action: "Try the other direction, or wait for a maker to quote.",
      retryable: true,
    });
  }
  const preflight = await preflightCall(client, {
    window: req.window, quote, account: req.account,
    ...(req.autoApprove !== undefined ? { autoApprove: req.autoApprove } : {}),
  });
  const { expiresAtSec, userData } = orderTiming(client, req);

  const trader = client.exchange.client.createTrader({
    ...(client.config.privateKey ? { privateKey: client.config.privateKey } : {}),
    ...(client.config.walletClient ? { walletClient: client.config.walletClient } : {}),
    ...(client.config.account ? { account: client.config.account } : {}),
    decimals: client.collateral.decimals,
  });

  const unsigned = await client.queue.run(() =>
    trader.buildPlaceOrder({
      pool: req.window.pool,
      side: quote.side,
      price: quote.limitPrice,
      quantity: quote.quantity,
      orderType: req.orderType ?? ORDER_TYPE_IOC,
      expireTimestampNs: BigInt(expiresAtSec) * 1_000_000_000n,
      userData,
    }),
  );

  // Replace the SDK's unlimited approval with one sized to this call. See
  // buildExactApproval: an infinite allowance is what a drainer asks for, and
  // wallet scanners treat it accordingly.
  const approval: UnsignedCall | undefined = preflight.needsApproval
    ? buildExactApproval(client, req.window.pool, quote.escrow)
    : undefined;

  return {
    quote,
    preflight,
    approval,
    order: unsigned.order,
    idempotencyKey: userData,
    expiresAtSec,
  };
}

export interface PlacedCall {
  readonly txHash: `0x${string}`;
  readonly orderId: bigint | undefined;
  readonly quote: Quote;
  /** Contracts actually filled. Zero means nothing was opened. */
  readonly filled: bigint;
  /** Collateral actually spent, priced at the fills. */
  readonly spent: bigint;
  readonly status: "FILLED" | "PARTIAL" | "UNFILLED";
  readonly fills: ReadonlyArray<{ quantity: bigint; price: bigint }>;
  readonly idempotencyKey: bigint;
  readonly explorerUrl: string;
}

/**
 * Quote, preflight, sign and send in one call, using the client's own signer.
 * Used by the CLI and smoke test; the web app uses `prepareCall` instead.
 */
export async function placeCall(client: DexClient, req: CallRequest): Promise<PlacedCall> {
  if (!client.config.privateKey && !client.config.walletClient && !client.config.account) {
    throw new DexError("UNKNOWN", "placeCall needs a signer.", {
      action: "Construct the client with a privateKey, account or walletClient.",
    });
  }

  const quote = await quoteCall(client, req);
  if (!quote) {
    throw new DexError("NO_LIQUIDITY", `No resting asks on the ${req.direction} side of this window.`, {
      action: "Try the other direction, or wait for a maker to quote.",
      retryable: true,
    });
  }
  await preflightCall(client, {
    window: req.window, quote, account: req.account,
    ...(req.autoApprove !== undefined ? { autoApprove: req.autoApprove } : {}),
  });

  // Re-read the on-chain status immediately before sending: quoting and any
  // user confirmation take real time, and the window may have locked meanwhile.
  const fresh = await client.queue.run(() => client.exchange.client.getMarketOnchain(req.window.marketId));
  if (fresh.status !== MarketStatus.Trading) {
    throw new DexError("WINDOW_CLOSED", `Window locked while composing (status ${fresh.status}).`, {
      action: "Roll to the next window and try again.",
    });
  }

  const { expiresAtSec, userData } = orderTiming(client, req);

  const trader = client.exchange.client.createTrader({
    ...(client.config.privateKey ? { privateKey: client.config.privateKey } : {}),
    ...(client.config.walletClient ? { walletClient: client.config.walletClient } : {}),
    ...(client.config.account ? { account: client.config.account } : {}),
    decimals: client.collateral.decimals,
  });

  let result: PlaceOrderResult;
  try {
    result = await trader.placeOrder({
      pool: req.window.pool,
      side: quote.side,
      price: quote.limitPrice,
      quantity: quote.quantity,
      orderType: req.orderType ?? ORDER_TYPE_IOC,
      expireTimestampNs: BigInt(expiresAtSec) * 1_000_000_000n,
      autoApprove: req.autoApprove ?? true,
      userData,
    });
  } catch (e) {
    // An IOC that finds nothing to fill against reverts with a distinct
    // reason, and it is COMMON: the ask side on a heavy favourite is often
    // empty, because nobody sells a near-certainty. Live testing hit this five
    // times consecutively at 80-83% implied.
    //
    // It deserves its own code because the user's fix is different -- a smaller
    // stake or the other side, not "wait for the next window".
    if (isUnfillable(e)) {
      throw new DexError(
        "NO_LIQUIDITY",
        "Nobody is currently selling that side at a price your order could take.",
        { action: "Try a smaller stake, or the other direction.", retryable: true },
      );
    }
    throw asDexError(e, "ORDER_REJECTED");
  }

  // A reverted SDK write resolves rather than throwing.
  if (result.receipt.status === "reverted") {
    throw new DexError("ORDER_REJECTED", `Order reverted on-chain. ${explorerTx(result.hash)}`, {
      action: "Usually the window locked, the price moved off the tick grid, or escrow was short.",
    });
  }

  const fills = result.fills.map((f) => ({ quantity: f.quantityFilled, price: f.fillPrice }));
  const filled = fills.reduce((sum, f) => sum + f.quantity, 0n);
  const unit = 10n ** BigInt(client.collateral.decimals);
  const spent = fills.reduce((sum, f) => sum + (f.quantity * f.price + unit - 1n) / unit, 0n);

  return {
    txHash: result.hash,
    orderId: result.orderId,
    quote,
    filled,
    spent,
    status: filled === 0n ? "UNFILLED" : filled < quote.quantity ? "PARTIAL" : "FILLED",
    fills,
    idempotencyKey: userData,
    explorerUrl: explorerTx(result.hash),
  };
}

/**
 * Order expiry is mandatory and capped at the market's own expiry. Sit just
 * inside it so a crashed client leaves nothing resting on the book — an
 * unfilled remainder rests with escrow locked, invisibly, otherwise.
 */
function orderTiming(client: DexClient, req: CallRequest): { expiresAtSec: number; userData: bigint } {
  const nowSec = client.clock.nowSec();
  const interval = req.window.intervalSec ?? 0;
  const expiresAtSec = Math.min(
    req.window.closesAtSec - 1,
    nowSec + Math.max(30, headroomSecFor(interval)),
  );
  if (expiresAtSec <= nowSec + 2) {
    throw new DexError(
      "WINDOW_CLOSED",
      `Window expires in ${req.window.closesAtSec - nowSec}s — too soon for an order to live.`,
      { action: "Roll to the next window." },
    );
  }
  return { expiresAtSec, userData: idempotencyKey(req.account, req.window.marketId) };
}
