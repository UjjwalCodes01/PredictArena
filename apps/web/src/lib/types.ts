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
  /** Brier score, 0-1. Lower is better; 0.25 is a coin flip. Null under the minimum. */
  brier: number | null;
  /** Percentage points of edge over the price paid. Positive means skill. */
  edge: number | null;
  /** Mean probability the market charged, 0-100. Context for `edge`. */
  avgImplied: number | null;
  lastWinAtSec: number | null;
  /**
   * Is this the AI forecaster?
   *
   * Decided on the SERVER from the configured wallet, never sent up by a
   * browser — otherwise anyone could wear the badge. It is a label only: the AI
   * is scored by the identical engine and gets no separate treatment anywhere.
   */
  isAi?: boolean;
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

/** One recorded estimate from the AI forecaster, shaped for display. */
export interface ForecastDto {
  readonly windowId: string;
  readonly asset: string;
  /** Probability of UP in basis points. 5000 = 50%. */
  readonly probabilityUpBps: number;
  readonly confidence: "LOW" | "MEDIUM" | "HIGH";
  readonly rationale: string;
  readonly keyFactors: readonly string[];
  readonly action: "PLACE" | "PASS";
  readonly passReason: string | null;
  readonly side: "UP" | "DOWN" | null;
  /** What the book was asking at the time, in basis points. Null if unknown. */
  readonly askUpBps: number | null;
  readonly askDownBps: number | null;
  /** Signed edge in basis points. Negative means the market charged more. */
  readonly edgeBps: number | null;
  readonly txHash: string | null;
  readonly closesAtSec: number;
  readonly createdAtSec: number;
  /** Filled in from `calls` once the window settles. Never stored alongside. */
  readonly outcome: "WON" | "LOST" | "VOID" | "PENDING" | null;
}

export interface AiResponse {
  /** False when no API key is set. The page says so rather than looking broken. */
  readonly configured: boolean;
  readonly wallet: string | null;
  readonly weekId: string;
  /** The forecaster's row on the same leaderboard as everyone else. */
  readonly standing: StandingDto | null;
  /** Median Brier across human players with enough settled calls. */
  readonly fieldBrier: number | null;
  readonly fieldEdge: number | null;
  readonly rankedPlayers: number;
  readonly summary: { total: number; placed: number; passed: number };
  /**
   * What a "50% every time" forecaster scores. Sent from the server rather
   * than imported: pulling it from `@predictarena/db` in a client component
   * dragged the Neon driver into the browser bundle, which the bundle guard
   * caught. One source of truth, no client import.
   */
  readonly coinFlipBrier: number;
  readonly forecasts: readonly ForecastDto[];
}
