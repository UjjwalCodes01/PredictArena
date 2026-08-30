/**
 * Optimistic pending calls.
 *
 * The properties that matter: a double-tap cannot produce two rows, and a row
 * disappears the instant the indexer reports the real one. A placeholder that
 * outlives its record would show a call twice.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { addPending, reconcile, clearPending, getPendingFor, type PendingCall } from "../pending.js";
import type { CallDto } from "../types.js";

const WALLET = "0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa";

function make(overrides: Partial<PendingCall> = {}): PendingCall {
  return {
    txHash: "0xtx1",
    wallet: WALLET,
    marketId: "0xmarket1",
    asset: "BTC",
    direction: "UP",
    stake: "1000000",
    quantity: "2000000",
    placedAt: new Date().toISOString(),
    idempotencyKey: "key-1",
    ...overrides,
  };
}

function serverCall(txHash: string): CallDto {
  return {
    id: "id", wallet: WALLET, windowId: "w", asset: "BTC", direction: "UP",
    status: "PENDING", stake: "1000000", quantity: "2000000", txHash,
    placedAt: new Date().toISOString(), settledAt: null,
    closesAtSec: null, intervalSec: null, weekId: "2026-W35",
  };
}

/** The store is testable without React: `usePending` only wraps this. */
const current = getPendingFor;

beforeEach(() => clearPending());

describe("pending calls", () => {
  it("a double-tap cannot create two rows for one window", () => {
    addPending(make());
    addPending(make({ txHash: "0xtx2" })); // same idempotency key
    expect(current(WALLET)).toHaveLength(1);
  });

  it("keeps distinct windows apart", () => {
    addPending(make({ idempotencyKey: "key-1", txHash: "0xtx1" }));
    addPending(make({ idempotencyKey: "key-2", txHash: "0xtx2" }));
    expect(current(WALLET)).toHaveLength(2);
  });

  it("drops a row once the indexer reports the same transaction", () => {
    addPending(make({ txHash: "0xABC" }));
    expect(current(WALLET)).toHaveLength(1);
    // Case differs -- hashes must match case-insensitively or the row lingers.
    reconcile([serverCall("0xabc")]);
    expect(current(WALLET)).toHaveLength(0);
  });

  it("leaves rows the indexer has not reported yet", () => {
    addPending(make({ txHash: "0xAAA", idempotencyKey: "k1" }));
    addPending(make({ txHash: "0xBBB", idempotencyKey: "k2" }));
    reconcile([serverCall("0xAAA")]);
    expect(current(WALLET).map((r) => r.txHash)).toEqual(["0xBBB"]);
  });

  it("never shows one account's calls under another", () => {
    addPending(make());
    expect(current("0xBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbb")).toHaveLength(0);
  });

  it("returns nothing when no wallet is connected", () => {
    addPending(make());
    expect(current(undefined)).toHaveLength(0);
  });

  it("clears everything on account change", () => {
    addPending(make());
    clearPending();
    expect(current(WALLET)).toHaveLength(0);
  });
});
