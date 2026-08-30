/**
 * Wire types shared between the API routes and the client.
 *
 * Amounts cross the wire as decimal STRINGS, never numbers: a JSON number is a
 * double, and putting an amount through one is exactly the mistake CLAUDE.md
 * rule 3 forbids.
 */
export interface WindowDto {
  marketId: string;
  asset: string;
  pool: string;
  question: string;
  strike: string;
  intervalSec: number | null;
  opensAtSec: number;
  closesAtSec: number;
  /** Chain-corrected at the moment the server answered. */
  secondsLeft: number;
  status: number;
  isTradable: boolean;
  /** Cost per contract, base units as a string. Null when that side is empty. */
  upPrice: string | null;
  downPrice: string | null;
}

export interface WindowsResponse {
  /** Server's chain-corrected clock, so the client can align its countdowns. */
  serverNowSec: number;
  windows: WindowDto[];
}

export interface QuoteDto {
  direction: "UP" | "DOWN";
  limitPrice: string;
  quantity: string;
  escrow: string;
  maxPayout: string;
}

export interface CallDto {
  id: string;
  wallet: string;
  /** Claimed display name, if this player has set one. */
  displayName?: string | null;
  windowId: string;
  asset: string;
  direction: "UP" | "DOWN";
  status: "PENDING" | "WON" | "LOST" | "VOID" | "FAILED";
  stake: string;
  quantity: string;
  txHash: string;
  placedAt: string;
  settledAt: string | null;
  closesAtSec: number | null;
  intervalSec: number | null;
  weekId: string;
}

export interface StandingDto {
  rank: number;
  wallet: string;
  /** Claimed display name, if this player has set one. */
  displayName?: string | null;
  points: number;
  wins: number;
  losses: number;
  voids: number;
  settled: number;
  currentStreak: number;
  bestStreak: number;
  calibration: number | null;
  lastWinAtSec: number | null;
}

export interface StandingsResponse {
  weekId: string;
  weekStartIso: string;
  standings: StandingDto[];
}

export interface ProfileDto {
  address: string;
  displayName: string | null;
  bio: string | null;
  twitter: string | null;
  website: string | null;
  firstSeenAt: string | null;
  profileUpdatedAt?: string | null;
}

/** Every API failure carries a machine code the UI switches on. */
export interface ApiError {
  code: string;
  message: string;
  action?: string;
}
