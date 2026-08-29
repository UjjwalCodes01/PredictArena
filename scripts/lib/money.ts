/**
 * Money formatting. Every onchain amount is a bigint; formatting happens only
 * at the display edge (CLAUDE.md hard rule 3 — "if you write parseFloat near an
 * amount, you are wrong").
 *
 * Deliberately small. An earlier draft also carried `parseAmount`,
 * `contractsForStake` and `costOf`; they were removed in the Phase 0 audit for
 * two reasons:
 *
 *  1. Nothing used them — Phase 0 sizes orders with the SDK's exported
 *     `quoteBinaryStakeOverBook`, via `quoteStakeOnChain()` in `dex.ts`.
 *  2. `contractsForStake` was actively wrong. It divided the stake by a single
 *     price, but a real book has depth: the SDK sweeps levels cheapest-first
 *     and prices the fill at the worst level touched. Anything reaching past
 *     the top level would have been sized too large.
 *
 * Phase 1 reintroduces parsing when the UI needs it — test-first, as CLAUDE.md
 * requires for money math, with the round-trip property test it specifies.
 */

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/**
 * Format base units for display with a fixed number of decimal places.
 * Truncates rather than rounds — never show a user more than they hold.
 */
export function formatFixed(raw: bigint, decimals: number, places: number): string {
  if (decimals < 0 || places < 0) throw new MoneyError("decimals and places must be non-negative.");
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const unit = 10n ** BigInt(decimals);
  const whole = abs / unit;
  const fraction = abs % unit;
  const sign = negative ? "-" : "";
  if (places === 0) return `${sign}${whole}`;
  const frac = fraction.toString().padStart(decimals, "0").slice(0, places).padEnd(places, "0");
  return `${sign}${whole}.${frac}`;
}

/**
 * Render a raw price as a percentage. Binary prices ARE probabilities in
 * collateral units: on a 6-decimal venue 0.62 is `620_000n`.
 */
export function priceToPercent(price: bigint, decimals: number): string {
  const bps = (price * 10_000n) / 10n ** BigInt(decimals);
  return `${formatFixed(bps, 2, 1)}%`;
}

/** STT, the native gas token, is 18 decimals — unlike the 6-decimal collateral. */
export const NATIVE_DECIMALS = 18;
export const formatStt = (wei: bigint): string => formatFixed(wei, NATIVE_DECIMALS, 4);
