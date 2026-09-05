/**
 * The scoring engine. One pure function, no I/O, no clock, no randomness.
 *
 * Points are DERIVED data (AGENTS.md section 4): raw settlements are what we
 * store, and standings are recomputed from them. That makes a reorg or a late
 * correction a recompute rather than a repair, so this function must be
 * deterministic and idempotent -- both are pinned by tests.
 *
 * Every rule, and each ambiguity it resolves, is pinned by a table-driven
 * test in scoring.test.ts — the tests are the specification.
 */
import {
  CALIBRATION_MIN_SETTLED, POINTS_PER_WIN,
  type ScorableCall, type Standing,
} from "./types";

/**
 * Streak multiplier, expressed times ten so all arithmetic stays integer and no
 * float ever enters scoring. The win that REACHES 3 is the one that earns
 * x1.5, because that is how a player counts it.
 */
export function streakMultiplierX10(streak: number): number {
  if (streak >= 5) return 20;
  if (streak >= 3) return 15;
  return 10;
}

/** Points for a win that brings the streak to `streak`. Always a whole number. */
export function pointsForWin(streak: number): number {
  return (POINTS_PER_WIN * streakMultiplierX10(streak)) / 10;
}

/** Statuses that participate at all. PENDING and FAILED are invisible to scoring. */
const SETTLED = new Set(["WON", "LOST", "VOID"]);

/**
 * Standings for one league week.
 *
 * Calls outside `weekId` are ignored, so a week's table is computable from that
 * week's calls alone -- which is what keeps a streak from spanning the Monday
 * reset.
 */
/**
 * Forecast-accuracy minimum. Below this a Brier score is noise, not a signal:
 * one lucky longshot moves it more than genuine skill ever would.
 */
export const SKILL_MIN_SETTLED = 5;

/** A "50% every time" forecaster scores exactly this. The line between skill and guessing. */
export const BRIER_COIN_FLIP = 0.25;

/**
 * The probability a call asserted, as a fraction 0–1.
 *
 * On a binary venue the price paid IS the claim: buying UP at 0.62 asserts
 * that UP is 62% likely. Price is stake divided by contracts.
 *
 * Returns null when no honest price can be derived — zero contracts, or a
 * value outside (0,1] that fees or rounding could produce. A bad price must
 * drop out of the average rather than poison it.
 */
export function impliedProbability(stake: bigint, quantity: bigint): number | null {
  if (quantity <= 0n || stake <= 0n) return null;
  // Scaled before dividing so integer division does not floor the result away.
  const scaled = Number((stake * 1_000_000n) / quantity) / 1_000_000;
  if (!Number.isFinite(scaled) || scaled <= 0 || scaled > 1) return null;
  return scaled;
}

/** Round to `places`, avoiding the float dust that makes 0.1+0.2 embarrassing. */
function round(value: number, places: number): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

export function computeStandings(calls: readonly ScorableCall[], weekId: string): Standing[] {
  // One scoring call per wallet per window (AGENTS.md section 5, anti-farming).
  // Extra calls still exist on-chain; they simply do not score. The EARLIEST
  // call on a window wins the slot, so a player cannot place both directions
  // and keep whichever settles well.
  const chosen = new Map<string, ScorableCall>();
  for (const c of calls) {
    if (c.weekId !== weekId || !SETTLED.has(c.status)) continue;
    const key = `${c.wallet} ${c.windowId}`;
    const held = chosen.get(key);
    if (!held || c.placedAtSec < held.placedAtSec || (c.placedAtSec === held.placedAtSec && c.id < held.id)) {
      chosen.set(key, c);
    }
  }

  const byWallet = new Map<string, ScorableCall[]>();
  for (const c of chosen.values()) {
    const list = byWallet.get(c.wallet);
    if (list) list.push(c);
    else byWallet.set(c.wallet, [c]);
  }

  const standings: Array<Omit<Standing, "rank">> = [];

  for (const [wallet, walletCalls] of byWallet) {
    // Streaks follow the moment an outcome became KNOWN -- the window close --
    // not when the call was placed. Ties resolved deterministically.
    const ordered = [...walletCalls].sort(
      (a, b) =>
        a.closesAtSec - b.closesAtSec ||
        (a.windowId < b.windowId ? -1 : a.windowId > b.windowId ? 1 : 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );

    let points = 0;
    let wins = 0;
    let losses = 0;
    let voids = 0;
    let streak = 0;
    let bestStreak = 0;
    let lastWinAtSec: number | null = null;
    // Brier and edge inputs. Only calls with a derivable price contribute, so
    // this count can be lower than `settled`.
    let squaredErrorSum = 0;
    let impliedSum = 0;
    let pricedWins = 0;
    let pricedCalls = 0;

    /**
     * Fold one settled call into the skill figures.
     *
     * `outcome` is 1 for a win, 0 for a loss. Voids never reach here: they have
     * no outcome, so squaring an error against them would be meaningless.
     */
    const accumulate = (call: ScorableCall, outcome: 0 | 1): void => {
      const p = impliedProbability(call.stake, call.quantity);
      if (p === null) return;
      squaredErrorSum += (p - outcome) ** 2;
      impliedSum += p;
      pricedCalls += 1;
      if (outcome === 1) pricedWins += 1;
    };

    for (const c of ordered) {
      switch (c.status) {
        case "WON":
          streak += 1;
          bestStreak = Math.max(bestStreak, streak);
          points += pointsForWin(streak);
          wins += 1;
          lastWinAtSec = c.closesAtSec;
          accumulate(c, 1);
          break;
        case "LOST":
          streak = 0;
          losses += 1;
          accumulate(c, 0);
          break;
        case "VOID":
          // Neither scores nor breaks the streak: a void refunds the stake, so
          // treating it as a loss would punish a player for the venue's problem.
          voids += 1;
          break;
        default:
          break;
      }
    }

    const settled = wins + losses;
    if (settled === 0 && voids === 0) continue;

    standings.push({
      wallet,
      points,
      wins,
      losses,
      voids,
      settled,
      currentStreak: streak,
      bestStreak,
      // Below the minimum the figure is noise, so the UI shows a dash instead.
      calibration: settled >= CALIBRATION_MIN_SETTLED ? round1((wins * 100) / settled) : null,
      // Gated on PRICED calls, not settled ones: a call whose price could not
      // be derived contributes to neither figure, so it must not count toward
      // the threshold that says they are trustworthy.
      brier:
        pricedCalls >= SKILL_MIN_SETTLED ? round(squaredErrorSum / pricedCalls, 3) : null,
      edge:
        pricedCalls >= SKILL_MIN_SETTLED
          ? round(((pricedWins - impliedSum) / pricedCalls) * 100, 1)
          : null,
      avgImplied:
        pricedCalls >= SKILL_MIN_SETTLED ? round((impliedSum / pricedCalls) * 100, 1) : null,
      lastWinAtSec,
    });
  }

  standings.sort(
    (a, b) =>
      b.points - a.points ||
      (b.calibration ?? -1) - (a.calibration ?? -1) ||
      // Earlier last win ranks higher: getting there first breaks the tie.
      (a.lastWinAtSec ?? Number.MAX_SAFE_INTEGER) - (b.lastWinAtSec ?? Number.MAX_SAFE_INTEGER) ||
      // Final, stable tie-break so an equal record never orders randomly.
      (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0),
  );

  return standings.map((s, i) => ({ rank: i + 1, ...s }));
}

/** One decimal place, without float display artefacts like 33.300000000000004. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
