/**
 * The replay window on wallet signatures.
 *
 * Before these, a captured profile or challenge signature was valid forever:
 * nothing in the signed text said WHEN it was signed, so nothing could ever
 * refuse it. The damage was bounded — replaying only repeats the same write —
 * but a signature lifted from a log could keep resurrecting an old bio
 * indefinitely. Now the text carries its own timestamp and the server refuses
 * stale ones, so a leaked signature ages out like a session.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  profileMessage, challengeMessage, signatureStaleness, SIGNATURE_TTL_MS,
} from "../signedMessage";

const NOW = new Date("2026-09-04T12:00:00Z");

afterEach(() => vi.useRealTimers());

describe("signatureStaleness", () => {
  it("accepts a signature made just now", () => {
    vi.useFakeTimers({ now: NOW });
    expect(signatureStaleness(NOW.toISOString())).toBeNull();
  });

  it("accepts one from a few minutes ago — a slow reader is not an attacker", () => {
    vi.useFakeTimers({ now: NOW });
    const fiveMinAgo = new Date(NOW.getTime() - 5 * 60_000).toISOString();
    expect(signatureStaleness(fiveMinAgo)).toBeNull();
  });

  it("refuses one older than the TTL", () => {
    vi.useFakeTimers({ now: NOW });
    const old = new Date(NOW.getTime() - SIGNATURE_TTL_MS - 1_000).toISOString();
    expect(signatureStaleness(old)).toMatch(/expired/i);
  });

  it("tolerates small forward clock skew but refuses a genuinely future date", () => {
    vi.useFakeTimers({ now: NOW });
    const slightlyAhead = new Date(NOW.getTime() + 60_000).toISOString();
    expect(signatureStaleness(slightlyAhead)).toBeNull();
    const farAhead = new Date(NOW.getTime() + 10 * 60_000).toISOString();
    expect(signatureStaleness(farAhead)).toMatch(/future|clock/i);
  });

  it("refuses a missing or unparseable timestamp, naming the problem", () => {
    expect(signatureStaleness(undefined)).toMatch(/missing/i);
    expect(signatureStaleness("")).toMatch(/missing/i);
    expect(signatureStaleness("not-a-date")).toMatch(/not a valid date/i);
    expect(signatureStaleness(12345)).toMatch(/missing/i);
  });
});

describe("the signed texts", () => {
  it("profile message binds the timestamp, so a replay cannot refresh it", () => {
    // If issuedAt travelled OUTSIDE the signed text, an attacker could re-post
    // a captured signature with a newer timestamp. Inside the text, changing
    // the timestamp invalidates the signature.
    const a = profileMessage("0xAbC", { displayName: "alice" }, "2026-09-04T12:00:00Z");
    const b = profileMessage("0xAbC", { displayName: "alice" }, "2026-09-04T12:05:00Z");
    expect(a).toContain("Issued at: 2026-09-04T12:00:00Z");
    expect(a).not.toBe(b);
  });

  it("challenge message binds both wallets, the window, and the timestamp", () => {
    const m = challengeMessage("0xAA", "0xBB", "0xwindow", "2026-09-04T12:00:00Z");
    expect(m).toContain("0xaa");
    expect(m).toContain("0xbb");
    expect(m).toContain("0xwindow");
    expect(m).toContain("Issued at: 2026-09-04T12:00:00Z");
  });

  it("addresses are lowercased, so checksum casing cannot fork the text", () => {
    expect(profileMessage("0xAbCdEf", {}, "t")).toBe(profileMessage("0xabcdef", {}, "t"));
  });
});
