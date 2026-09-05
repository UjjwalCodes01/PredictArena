/**
 * The protective pad on a taker's limit price.
 *
 * From production, 5 Sep 2026: a 10 tUSDC call quoted 19.72 contracts at
 * ~50.7c, and the order died on-chain with ImmediateOrCancelNoFill
 * (0xd48c4403) — while the SAME call at 1 tUSDC filled. The limit was set to
 * the exact walked price, so the moment a testnet maker re-quoted one level,
 * the larger order (which had walked deeper) matched nothing at all.
 *
 * An IOC limit is a protection bound, not a target: fills happen at each
 * resting order's own price, never at the limit. So padding the limit is FREE
 * when the book has not moved, and turns "revert, gas burned" into "filled at
 * the real price" when it has. The quantity is then sized against the PADDED
 * price, which restores the product's invariant: whatever the book does, the
 * spend can never exceed the stake the player chose.
 */
import { describe, it, expect } from "vitest";
import { protectQuote } from "../orders";

const ONE = 1_000_000n; // 6dp collateral: 1.0 contract redeems for this
const TICK = 1_000n; // 0.1%
const LOT = 10_000n; // 0.01 contracts
const grid = { tickSize: TICK, lotSize: LOT };

/** The incident's shape: 10 tUSDC at 50.7c walked exactly. */
const STAKE = 10_000_000n;
const walked = { limitPrice: 507_000n, quantity: 19_720_000n, escrow: 9_998_040n };

describe("protectQuote", () => {
  it("pads the limit above the walked price, aligned to the tick grid", () => {
    const p = protectQuote(walked, grid, ONE, STAKE);
    expect(p.limitPrice).toBeGreaterThan(walked.limitPrice);
    expect(p.limitPrice % TICK).toBe(0n);
    // ~1% of 50.7c, rounded up to a tick.
    expect(p.limitPrice - walked.limitPrice).toBeGreaterThanOrEqual(2n * TICK);
    expect(p.limitPrice - walked.limitPrice).toBeLessThanOrEqual(walked.limitPrice / 50n);
  });

  it("NEVER lets the worst case spend exceed the stake", () => {
    // The invariant the whole design hangs on: quantity is sized against the
    // padded limit, so even a fill at the very edge of the tolerance costs at
    // most the stake the player chose.
    const p = protectQuote(walked, grid, ONE, STAKE);
    expect((p.quantity * p.limitPrice) / ONE).toBeLessThanOrEqual(STAKE);
  });

  it("keeps the quantity lot-aligned and never above what the book was quoted for", () => {
    const p = protectQuote(walked, grid, ONE, STAKE);
    expect(p.quantity % LOT).toBe(0n);
    expect(p.quantity).toBeLessThanOrEqual(walked.quantity);
    expect(p.quantity).toBeGreaterThan(0n);
  });

  it("gives up only a sliver of size for the protection", () => {
    // ~1% tolerance should cost ~1% of the contracts, not more.
    const p = protectQuote(walked, grid, ONE, STAKE);
    expect(p.quantity).toBeGreaterThanOrEqual((walked.quantity * 98n) / 100n);
  });

  it("scales the displayed escrow down with the quantity, never up", () => {
    const p = protectQuote(walked, grid, ONE, STAKE);
    expect(p.escrow).toBeLessThanOrEqual(walked.escrow);
    expect(p.escrow).toBeGreaterThan(0n);
  });

  it("caps the padded limit below 1.0 — a contract can never cost its own payout", () => {
    const nearCertain = { limitPrice: 995_000n, quantity: 10_000_000n, escrow: 9_950_000n };
    const p = protectQuote(nearCertain, grid, ONE, STAKE);
    expect(p.limitPrice).toBeLessThan(ONE);
    expect((p.quantity * p.limitPrice) / ONE).toBeLessThanOrEqual(STAKE);
  });

  it("returns the quote unchanged when the walked price is already at the cap", () => {
    const atCap = { limitPrice: ONE - TICK, quantity: 10_000_000n, escrow: 9_990_000n };
    expect(protectQuote(atCap, grid, ONE, STAKE)).toEqual(atCap);
  });

  it("pads a cheap long shot by whole ticks, not by rounding dust", () => {
    // At 2c, 1% is 200 — below one tick. The pad must still be real ticks.
    const longshot = { limitPrice: 20_000n, quantity: 500_000_000n, escrow: 10_000_000n };
    const p = protectQuote(longshot, grid, ONE, STAKE);
    expect(p.limitPrice).toBe(20_000n + 2n * TICK);
    expect((p.quantity * p.limitPrice) / ONE).toBeLessThanOrEqual(STAKE);
  });
});
