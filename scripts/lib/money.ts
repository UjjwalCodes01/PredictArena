/**
 * Money math. Every onchain amount is a bigint; formatting happens only at the
 * display edge (CLAUDE.md hard rule 3 — "if you write parseFloat near an
 * amount, you are wrong").
 *
 * Nothing here uses Number for a value. Parsing is string surgery so that
 * "0.1" + "0.2" can never become 0.30000000000000004, and so that a
 * 6-decimal venue and an 18-decimal venue behave identically.
 *
 * Phase 1 promotes this file into `packages/dex` with property tests
 * (format(parse(x)) round-trips).
 */

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/**
 * Parse a human decimal string into base units. Rejects floats-as-numbers by
 * only accepting strings, and rejects more precision than the token has rather
 * than silently truncating someone's stake.
 */
export function parseAmount(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new MoneyError(`"${value}" is not a plain decimal amount.`);
  }
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  if (fraction.length > decimals) {
    throw new MoneyError(
      `"${value}" has ${fraction.length} decimal places but the token has only ${decimals}. ` +
        `Round it before parsing — silently truncating a stake is how users lose money.`,
    );
  }
  const padded = fraction.padEnd(decimals, "0");
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
  return negative ? -raw : raw;
}

/** Format base units as a human string. Exact — no rounding, no Number. */
export function formatAmount(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const unit = 10n ** BigInt(decimals);
  const whole = abs / unit;
  const fraction = abs % unit;
  const sign = negative ? "-" : "";
  if (fraction === 0n) return `${sign}${whole}`;
  const frac = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${sign}${whole}.${frac}`;
}

/** Format for display with a fixed number of decimal places (truncating). */
export function formatFixed(raw: bigint, decimals: number, places: number): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const unit = 10n ** BigInt(decimals);
  const whole = abs / unit;
  const fraction = abs % unit;
  const sign = negative ? "-" : "";
  if (places <= 0) return `${sign}${whole}`;
  const frac = fraction.toString().padStart(decimals, "0").slice(0, places).padEnd(places, "0");
  return `${sign}${whole}.${frac}`;
}

/**
 * Probabilities are prices in collateral units: on a 6-decimal venue 0.62 is
 * 620_000n. Taking the probability as a string keeps floats out of the path —
 * the bot kit measured `(0.05).toFixed(18)` landing three wei off the tick grid
 * and being rejected with `InvalidPrice` (docs/dex-notes.md §8.4).
 */
export function probabilityToPrice(probability: string, decimals: number): bigint {
  const raw = parseAmount(probability, decimals);
  const unit = 10n ** BigInt(decimals);
  if (raw <= 0n || raw >= unit) {
    throw new MoneyError(`Probability must be strictly between 0 and 1, got "${probability}".`);
  }
  return raw;
}

/** Render a raw price as a percentage string for display, e.g. 620000n -> "62.0%". */
export function priceToPercent(price: bigint, decimals: number): string {
  const bps = (price * 10_000n) / 10n ** BigInt(decimals);
  return `${formatFixed(bps, 2, 1)}%`;
}

/**
 * Snap a value DOWN to a grid (tick or lot). The SDK's generic
 * `amountToPrecision` skips lot sizing on binary markets and floors small sizes
 * to zero, so we always quantize ourselves (docs/dex-notes.md §8.6).
 */
export function quantizeDown(value: bigint, step: bigint): bigint {
  if (step <= 0n) throw new MoneyError("Grid step must be positive.");
  return (value / step) * step;
}

/** Snap UP to a grid — used for prices we are willing to pay at most. */
export function quantizeUp(value: bigint, step: bigint): bigint {
  if (step <= 0n) throw new MoneyError("Grid step must be positive.");
  const down = (value / step) * step;
  return down === value ? value : down + step;
}

/**
 * Contracts affordable with `stake` at `price`, snapped to the lot grid.
 * A winning contract redeems for exactly 1 unit of collateral, so
 * quantity = stake / price, and the payout is quantity × 1.
 */
export function contractsForStake(stake: bigint, price: bigint, decimals: number, lotSize: bigint): bigint {
  if (price <= 0n) throw new MoneyError("Price must be positive.");
  const unit = 10n ** BigInt(decimals);
  return quantizeDown((stake * unit) / price, lotSize);
}

/** Cost of `quantity` contracts at `price`, rounded up (never under-fund an order). */
export function costOf(quantity: bigint, price: bigint, decimals: number): bigint {
  const unit = 10n ** BigInt(decimals);
  const exact = quantity * price;
  return exact % unit === 0n ? exact / unit : exact / unit + 1n;
}

/** STT (native gas token) is 18 decimals, unlike the 6-decimal collateral. */
export const NATIVE_DECIMALS = 18;
export const formatStt = (wei: bigint): string => formatFixed(wei, NATIVE_DECIMALS, 4);
