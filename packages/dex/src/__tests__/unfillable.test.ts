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
