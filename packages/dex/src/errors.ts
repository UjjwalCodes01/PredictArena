/**
 * Typed errors. The UI switches on `code`; a generic "something went wrong" is
 * a bug (CLAUDE.md, "Error handling pattern").
 */

export type DexErrorCode =
  /** The window is locked, settled, or too near expiry to accept an order. */
  | "WINDOW_CLOSED"
  /** Not enough collateral (tUSDC) to cover the escrow, or below the venue minimum. */
  | "INSUFFICIENT_STAKE"
  /** Not enough native STT to fund the transaction's gas ceiling. */
  | "INSUFFICIENT_GAS"
  /** An ERC-20 approval must be sent first. Returned as a pre-step, not a failure. */
  | "NEEDS_APPROVAL"
  /** The order reverted, or filled nothing. */
  | "ORDER_REJECTED"
  /** No resting asks on the requested side. */
  | "NO_LIQUIDITY"
  /** No live windows matched the request. */
  | "NO_MARKETS"
  /** Upstream asked us to slow down. */
  | "RATE_LIMITED"
  /** The indexer or RPC is unreachable. */
  | "API_DOWN"
  /** The RPC is not Shannon. */
  | "CHAIN_MISMATCH"
  /** Something pointed at mainnet. Always fatal. */
  | "MAINNET_FORBIDDEN"
  /** A settlement did not finalise inside the deadline. */
  | "SETTLEMENT_TIMEOUT"
  | "UNKNOWN";

export interface DexErrorOptions {
  /** What the user or operator should do. Required for anything user-facing. */
  action?: string;
  cause?: unknown;
  /** True when retrying the same call unchanged could plausibly succeed. */
  retryable?: boolean;
}

export class DexError extends Error {
  readonly code: DexErrorCode;
  readonly action: string | undefined;
  readonly retryable: boolean;

  constructor(code: DexErrorCode, message: string, opts: DexErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "DexError";
    this.code = code;
    this.action = opts.action;
    this.retryable = opts.retryable ?? RETRYABLE_BY_DEFAULT.has(code);
  }

  static is(e: unknown, code?: DexErrorCode): e is DexError {
    return e instanceof DexError && (code === undefined || e.code === code);
  }
}

const RETRYABLE_BY_DEFAULT = new Set<DexErrorCode>(["RATE_LIMITED", "API_DOWN"]);

/** Wraps an unknown throw as a DexError without losing the original. */
export function asDexError(e: unknown, fallback: DexErrorCode = "UNKNOWN"): DexError {
  if (e instanceof DexError) return e;
  const message = e instanceof Error ? e.message : String(e);
  // The SDK surfaces transport failures as plain Errors; classify the common ones
  // so callers get an actionable code instead of UNKNOWN.
  if (/rate.?limit|429/i.test(message)) {
    return new DexError("RATE_LIMITED", message, { cause: e, action: "Retry shortly." });
  }
  if (/fetch failed|ECONN|ETIMEDOUT|socket|network|indexer/i.test(message)) {
    return new DexError("API_DOWN", message, {
      cause: e,
      action: "The indexer or RPC is unreachable. Chain reads still work; retry shortly.",
    });
  }
  return new DexError(fallback, message, { cause: e });
}
