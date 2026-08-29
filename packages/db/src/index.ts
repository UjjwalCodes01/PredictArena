/**
 * `@predictarena/db` -- schema, queries, and the pure scoring engine.
 *
 * The database is a projection of chain truth. Nothing here is authoritative;
 * on any disagreement the chain wins and the row is corrected from it.
 */
export { createDb, createSql, DbConfigError, schema, type Database } from "./client.js";

export {
  windows, calls, wallets, syncState, callStatus, direction, windowStatus,
  type WindowRow, type NewWindowRow, type CallRow, type NewCallRow,
  type WalletRow, type SyncStateRow,
} from "./schema.js";

export {
  upsertWindow, upsertCall, markWindowSettled, settleCallsForWindow, getNonTerminalCalls, getOverdueCalls,
  getOpenWindows, touchWallet, getSyncState, setSyncState, getScorableCalls,
  getStandings, getWalletCalls, getWindowsByIds, TERMINAL_STATUSES,
} from "./queries.js";

export { computeStandings, streakMultiplierX10, pointsForWin } from "./scoring.js";
export { isoWeekId, weekIdForClose, weekStartUtc, currentWeekId } from "./week.js";

export {
  CALIBRATION_MIN_SETTLED, POINTS_PER_WIN,
  type CallStatus, type Direction, type ScorableCall, type Standing,
} from "./types.js";
