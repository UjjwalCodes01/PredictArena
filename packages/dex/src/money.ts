/**
 * Money math. Every onchain amount is a `bigint`; formatting happens only at the
 * display edge (CLAUDE.md hard rule 3).
 *
 * Parsing is string surgery, never `Number`, so "0.1" + "0.2" can never become
 * 0.30000000000000004 and a 6-decimal venue behaves exactly like an 18-decimal
 * one. Binary prices ARE probabilities in collateral units: on a 6-decimal
 * venue 0.62 is `620_000n`.
 */

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/** Parse a human decimal string into base units. Rejects excess precision. */
export function parseAmount(value: string, decimals: number): bigint {
  if (decimals < 0 || !Number.isInteger(decimals)) throw new MoneyError("decimals must be a non-negative integer.");
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new MoneyError(`"${value}" is not a plain decimal amount.`);
  }
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  if (fraction.length > decimals) {
    throw new MoneyError(
      `"${value}" has ${fraction.length} decimal places but the token has ${decimals}. ` +
        `Round before parsing — silently truncating a stake loses a user's money.`,
    );
  }
  const padded = fraction.padEnd(decimals, "0");
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded === "" ? "0" : padded);
  return negative ? -raw : raw;
}

/** Exact formatting — no rounding, no `Number`. Trailing zeros trimmed. */
export function formatAmount(raw: bigint, decimals: number): string {
  const { sign, whole, fraction } = split(raw, decimals);
  if (fraction === 0n) return `${sign}${whole}`;
  const frac = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${sign}${whole}.${frac}`;
}

/**
 * Display formatting with fixed places. Truncates rather than rounds — a user
 * must never be shown more than they actually hold.
 */
export function formatFixed(raw: bigint, decimals: number, places: number): string {
  if (decimals < 0 || places < 0) throw new MoneyError("decimals and places must be non-negative.");
  const { sign, whole, fraction } = split(raw, decimals);
  if (places === 0) return `${sign}${whole}`;
  const frac = fraction.toString().padStart(decimals, "0").slice(0, places).padEnd(places, "0");
  return `${sign}${whole}.${frac}`;
}

function split(raw: bigint, decimals: number): { sign: string; whole: bigint; fraction: bigint } {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const unit = 10n ** BigInt(decimals);
  return { sign: negative ? "-" : "", whole: abs / unit, fraction: abs % unit };
}

/** Render a raw price as a percentage, e.g. 620000n @6dp -> "62.0%". */
export function priceToPercent(price: bigint, decimals: number, places = 1): string {
  const scaled = (price * 10n ** BigInt(2 + places)) / 10n ** BigInt(decimals);
  return `${formatFixed(scaled, places, places)}%`;
}

/**
 * Probability (0,1) as a string -> raw price. Taking a string keeps floats out:
 * `(0.05).toFixed(18)` is `"0.050000000000000003"`, three wei off the tick grid,
 * which an 18-decimal venue rejects with `InvalidPrice`.
 */
export function probabilityToPrice(probability: string, decimals: number): bigint {
  const raw = parseAmount(probability, decimals);
  const unit = 10n ** BigInt(decimals);
  if (raw <= 0n || raw >= unit) {
    throw new MoneyError(`Probability must be strictly between 0 and 1, got "${probability}".`);
  }
  return raw;
}

/** Snap DOWN to a tick/lot grid. */
export function quantizeDown(value: bigint, step: bigint): bigint {
  if (step <= 0n) throw new MoneyError("Grid step must be positive.");
  return (value / step) * step;
}

/** Snap UP to a tick/lot grid — for a price we are willing to pay at most. */
export function quantizeUp(value: bigint, step: bigint): bigint {
  if (step <= 0n) throw new MoneyError("Grid step must be positive.");
  const down = (value / step) * step;
  return down === value ? value : down + step;
}

/** STT, the native gas token, is 18 decimals — unlike the 6-decimal collateral. */
export const NATIVE_DECIMALS = 18;
export const formatStt = (wei: bigint): string => formatFixed(wei, NATIVE_DECIMALS, 4);
