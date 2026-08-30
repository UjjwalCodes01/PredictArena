/**
 * Display formatting. The only place a bigint becomes a string for a human.
 *
 * Amounts stay bigint everywhere else (CLAUDE.md hard rule 3); this module is
 * the display edge the rule carves out.
 */
// Imported from the package's `money` subpath, NOT its index. These are pure
// arithmetic helpers; reaching them through the index pulled the entire venue
// SDK into the initial JavaScript bundle on every page — including the
// leaderboard, which never touches a wallet.
import { formatFixed, priceToPercent } from "@predictarena/dex/money";

export const COLLATERAL_DECIMALS = 6;
export const COLLATERAL_SYMBOL = "tUSDC";

/** Amounts as a human string, truncated -- never show more than someone holds. */
export function amount(raw: bigint | string, places = 2): string {
  const v = typeof raw === "string" ? BigInt(raw) : raw;
  return formatFixed(v, COLLATERAL_DECIMALS, places);
}

/** A binary price as a percentage. Prices ARE probabilities on this venue. */
export function percent(price: bigint, places = 1): string {
  return priceToPercent(price, COLLATERAL_DECIMALS, places);
}

/** Native gas token, 18 decimals -- not the collateral's 6. */
export function stt(wei: bigint, places = 3): string {
  return formatFixed(wei, 18, places);
}

/**
 * Checksum-truncated address, e.g. 0x1234…abcd.
 *
 * Addresses are stored lowercase; this is presentation only.
 */
export function shortAddress(address: string): string {
  if (address.length < 12) return address;
  return `${address.slice(0, 6)}\u2026${address.slice(-4)}`;
}

/**
 * A countdown as m:ss, or "0:00" once past.
 *
 * Takes seconds already corrected against chain time -- never a raw local
 * clock, because a user whose laptop is two minutes fast would otherwise see a
 * window as closed while it is still trading.
 */
export function countdown(secondsLeft: number): string {
  const s = Math.max(0, Math.floor(secondsLeft));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** "5 min", "1 hour" -- the series a window belongs to, in words. */
export function seriesLabel(intervalSec: number | null): string {
  if (!intervalSec) return "window";
  if (intervalSec < 60) return `${intervalSec} sec`;
  if (intervalSec < 3600) return `${Math.round(intervalSec / 60)} min`;
  if (intervalSec < 86400) return `${Math.round(intervalSec / 3600)} hour`;
  return `${Math.round(intervalSec / 86400)} day`;
}

/** Relative time for a settled call: "3 min ago". */
export function timeAgo(iso: string | Date): string {
  const then = typeof iso === "string" ? new Date(iso) : iso;
  const secs = Math.floor((Date.now() - then.getTime()) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} hr ago`;
  return `${Math.floor(secs / 86400)} d ago`;
}
