/**
 * Head-to-head duels.
 *
 * A duel is a VIEW over calls, never a separate record of who won. The stored
 * challenge says only who challenged whom on which window; the outcome is
 * computed from the same `calls` rows the leaderboard uses, which the indexer
 * derives from chain fills.
 *
 * That is the whole design. A duel cannot disagree with the leaderboard,
 * cannot be forged by a client, and needs no settlement job of its own — when
 * the calls settle, the duel has already resolved.
 */
import type { CallStatus, Direction } from "./types";

/** The states a duel can be in, all derived. */
export type DuelState =
  /** Window still open, or a side has not called yet. */
  | "OPEN"
  /** Window closed with at least one side never calling. */
  | "EXPIRED"
  /** Both called; the window voided. Nobody wins, nobody loses. */
  | "VOID"
  /** Both called and it is settled. */
  | "RESOLVED";

export type DuelResult =
  /** Challenger won, opponent did not. */
  | "CHALLENGER"
  /** Opponent won, challenger did not. */
  | "OPPONENT"
  /** Both won, or both lost. */
  | "DRAW"
  /** Not resolved. */
  | null;

/** One side's call in a duel, reduced to what decides it. */
export interface DuelSideCall {
  readonly status: CallStatus;
  readonly direction: Direction;
  readonly placedAtSec: number;
  readonly id: string;
}

export interface DuelInput {
  readonly challenger: string;
  readonly opponent: string;
  readonly windowId: string;
  readonly closesAtSec: number;
  /** Every call either side made on this window. Order irrelevant. */
  readonly calls: ReadonlyArray<DuelSideCall & { wallet: string }>;
}

export interface DuelOutcome {
  readonly state: DuelState;
  readonly result: DuelResult;
  readonly challengerCall: DuelSideCall | null;
  readonly opponentCall: DuelSideCall | null;
}

/** Terminal statuses — a call that has actually been decided. */
const DECIDED: ReadonlySet<CallStatus> = new Set<CallStatus>(["WON", "LOST", "VOID"]);

/**
 * The call that counts for one wallet on one window.
 *
 * The EARLIEST, matching the leaderboard's anti-farming rule exactly. Without
 * this a player could call both directions and claim whichever won — which is
 * precisely the hole that rule exists to close, and a duel is where someone
 * would most want to exploit it.
 *
 * Ties on time break on id, so the choice is deterministic.
 */
function countingCall(
  calls: DuelInput["calls"],
  wallet: string,
): DuelSideCall | null {
  const target = wallet.toLowerCase();
  let best: DuelSideCall | null = null;
  for (const c of calls) {
    if (c.wallet.toLowerCase() !== target) continue;
    if (
      !best ||
      c.placedAtSec < best.placedAtSec ||
      (c.placedAtSec === best.placedAtSec && c.id < best.id)
    ) {
      best = { status: c.status, direction: c.direction, placedAtSec: c.placedAtSec, id: c.id };
    }
  }
  return best;
}

/**
 * Resolve a duel from its calls.
 *
 * Pure and total: every combination of present/absent and settled/unsettled
 * calls maps to a state, so no caller has to guess what a missing side means.
 */
export function resolveDuel(input: DuelInput, nowSec: number): DuelOutcome {
  const challengerCall = countingCall(input.calls, input.challenger);
  const opponentCall = countingCall(input.calls, input.opponent);
  const windowClosed = nowSec >= input.closesAtSec;

  // Someone never turned up. Only final once the window has closed — before
  // that they can still accept.
  if (!challengerCall || !opponentCall) {
    return {
      state: windowClosed ? "EXPIRED" : "OPEN",
      result: null,
      challengerCall,
      opponentCall,
    };
  }

  // Both called, but the chain has not decided both yet.
  if (!DECIDED.has(challengerCall.status) || !DECIDED.has(opponentCall.status)) {
    return { state: "OPEN", result: null, challengerCall, opponentCall };
  }

  // A voided window has no outcome to compete over. Stakes are refunded, so
  // treating it as a loss for either side would punish someone for the
  // venue's problem — the same reasoning the league applies to voids.
  if (challengerCall.status === "VOID" || opponentCall.status === "VOID") {
    return { state: "VOID", result: null, challengerCall, opponentCall };
  }

  const challengerWon = challengerCall.status === "WON";
  const opponentWon = opponentCall.status === "WON";

  // Both right or both wrong is a draw. Two players can take the same side and
  // both be correct; that is not a defeat for either.
  if (challengerWon === opponentWon) {
    return { state: "RESOLVED", result: "DRAW", challengerCall, opponentCall };
  }

  return {
    state: "RESOLVED",
    result: challengerWon ? "CHALLENGER" : "OPPONENT",
    challengerCall,
    opponentCall,
  };
}

/** Head-to-head tally for one wallet across many duels. */
export interface DuelRecord {
  readonly won: number;
  readonly lost: number;
  readonly drawn: number;
  readonly open: number;
  readonly expired: number;
}

/**
 * Canonical key for a contest: the same two wallets on the same window, in
 * either direction.
 *
 * A challenges B, then B challenges A on the same window — that is one fight,
 * and a social feature invites exactly that. Sorting the pair makes both rows
 * collapse to one key.
 */
export function contestKey(a: string, b: string, windowId: string): string {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()].sort();
  return `${x}:${y}:${windowId}`;
}

export function tallyDuels(
  wallet: string,
  duels: ReadonlyArray<{ challenger: string; opponent: string; windowId?: string; outcome: DuelOutcome }>,
): DuelRecord {
  const me = wallet.toLowerCase();
  let won = 0, lost = 0, drawn = 0, open = 0, expired = 0;

  // Count each contest once. Both rows resolve identically, so keeping the
  // first is safe — what matters is not counting it twice.
  const counted = new Set<string>();

  for (const d of duels) {
    if (d.windowId !== undefined) {
      const key = contestKey(d.challenger, d.opponent, d.windowId);
      if (counted.has(key)) continue;
      counted.add(key);
    }
    const isChallenger = d.challenger.toLowerCase() === me;
    const isOpponent = d.opponent.toLowerCase() === me;
    // A duel this wallet is not part of contributes nothing, rather than
    // silently counting as a loss.
    if (!isChallenger && !isOpponent) continue;

    switch (d.outcome.state) {
      case "OPEN": open += 1; break;
      case "EXPIRED": expired += 1; break;
      case "VOID": drawn += 1; break;
      case "RESOLVED": {
        if (d.outcome.result === "DRAW") {
          drawn += 1;
        } else {
          // Did the side that won happen to be this wallet?
          const wonIt =
            (d.outcome.result === "CHALLENGER" && isChallenger) ||
            (d.outcome.result === "OPPONENT" && isOpponent);
          if (wonIt) won += 1;
          else lost += 1;
        }
        break;
      }
    }
  }

  return { won, lost, drawn, open, expired };
}
