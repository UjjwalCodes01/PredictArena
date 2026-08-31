/**
 * Recognising an order that could not fill.
 *
 * An IOC with no depth on the other side reverts with ImmediateOrCancel. That
 * must NOT be reported as the generic "window locked / price moved / escrow
 * short" message, because the user's fix is different: a smaller stake or the
 * other direction, not waiting for the next window.
 */
import { describe, it, expect } from "vitest";
import { isUnfillable } from "../orders.js";

describe("isUnfillable", () => {
  for (const text of [
    "@somnia-chain/markets-sdk: placeBinaryOrder reverted: ImmediateOrCancel",
    "Error: IMMEDIATEORCANCEL",
    "execution reverted: IOC",
    "reverted: ioc order not filled",
  ]) {
    it(`recognises ${JSON.stringify(text.slice(0, 44))}`, () => {
      expect(isUnfillable(new Error(text))).toBe(true);
    });
  }

  for (const text of [
    "insufficient allowance",
    "window closed",
    "execution reverted for an unknown reason",
    "ERC20: transfer amount exceeds balance",
    // "ioc" inside a longer word must not trigger it.
    "associoction failed",
  ]) {
    it(`leaves ${JSON.stringify(text.slice(0, 40))} alone`, () => {
      expect(isUnfillable(new Error(text))).toBe(false);
    });
  }

  it("handles a non-Error value without throwing", () => {
    expect(isUnfillable(undefined)).toBe(false);
    expect(isUnfillable({ reason: "ImmediateOrCancel" })).toBe(false);
  });
});

describe("recognising it from the SELECTOR, not just the text", () => {
  /**
   * A revert frequently arrives as a bare `Custom error: 0xd48c4403` with no
   * decoded name. A text-only check missed it, and the user got the generic
   * "the window locked or the price moved" — wrong, and nothing they could act
   * on. Selector 0xd48c4403 is `ImmediateOrCancelNoFill()`.
   */
  it("matches when the selector is nested in the error's data", () => {
    const err = { message: "reverted", cause: { data: "0xd48c4403" } };
    expect(isUnfillable(err)).toBe(true);
  });

  it("matches when the selector only appears in the message", () => {
    expect(isUnfillable(new Error("Transaction failed on-chain: Custom error: 0xd48c4403"))).toBe(true);
  });

  it("matches through a nested data.data shape", () => {
    const err = { cause: { cause: { data: { data: "0xd48c4403000000" } } } };
    expect(isUnfillable(err)).toBe(true);
  });

  it("does NOT match a different custom error", () => {
    // 0xfb8f41b2 is ERC20InsufficientAllowance — a real, different problem
    // that must keep its own message.
    expect(isUnfillable({ cause: { data: "0xfb8f41b2" } })).toBe(false);
  });
});
