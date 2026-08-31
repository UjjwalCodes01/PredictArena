/**
 * The forecaster, running.
 *
 * It reads live windows, asks the model for a probability, compares that to
 * what the book is charging, and places a real order only when the gap clears
 * its threshold. Everything it does is an ordinary wallet action on the real
 * venue, which is the point: no special table decides whether it won, and the
 * same pure scoring engine ranks it against every human player.
 *
 * The default outcome is to do nothing. A missing key, an unreadable response,
 * a thin book, a market that already agrees — all of them end in a pass, and a
 * pass is recorded with its reason so the site can show that declining to bet
 * was a decision rather than a failure.
 */
import {
  getWindows, getTopOfBook, quoteCall, placeCall, headroomSecFor, DexError,
  type DexClient, type Window,
} from "@predictarena/dex";
import {
  forecastId, recordForecast, forecastedWindowIds, getResolvedHistory, weekIdForClose,
  type Database,
} from "@predictarena/db";
import { decide } from "./decide";
import { forecastWindow, isConfigured } from "./forecast";
import type { WindowContext } from "./prompt";
import { unitsToBps } from "./decide";
import type { Decision } from "./types";

/**
 * Seconds a window must have left BEYOND the venue's own headroom.
 *
 * The model call is not instant — adaptive thinking on a real judgement runs
 * several seconds — and a forecast that arrives after the window locks is
 * wasted spend. Budget for the round trip before committing to it.
 */
const FORECAST_BUDGET_SEC = 25;

/** Per run. Small on purpose: this executes inside a request, not a daemon. */
const MAX_FORECASTS = 2;
const MAX_PLACEMENTS = 1;

export interface AgentOptions {
  readonly dex: DexClient;
  readonly db: Database;
  /** The forecaster's own address. Its calls are indexed like anyone's. */
  readonly wallet: `0x${string}`;
  /** Collateral per call, base units. */
  readonly stake: bigint;
  readonly assets: readonly string[];
  readonly maxForecasts?: number;
  readonly maxPlacements?: number;
}

export interface AgentRun {
  /** Live windows that were eligible to be looked at. */
  readonly considered: number;
  readonly forecast: number;
  readonly placed: number;
  readonly passed: number;
  readonly skipped: number;
  readonly notes: readonly string[];
}

/** Is there enough of this window left to be worth spending a forecast on? */
function hasRoom(w: Window): boolean {
  return w.secondsLeft > FORECAST_BUDGET_SEC + headroomSecFor(w.intervalSec ?? 0);
}

/**
 * One pass over the live board.
 *
 * Never throws: a forecaster that takes the page down when the venue is slow
 * is worse than one that quietly does nothing.
 */
export async function runAgent(opts: AgentOptions): Promise<AgentRun> {
  const { dex, db, wallet, stake, assets } = opts;
  const maxForecasts = opts.maxForecasts ?? MAX_FORECASTS;
  const maxPlacements = opts.maxPlacements ?? MAX_PLACEMENTS;
  const notes: string[] = [];

  if (!isConfigured()) {
    return { considered: 0, forecast: 0, placed: 0, passed: 0, skipped: 0, notes: ["no API key"] };
  }

  const decimals = dex.collateral.decimals;

  // Live, tradable windows across the assets we follow.
  const live: Window[] = [];
  for (const asset of assets) {
    try {
      const found = await getWindows(dex, { asset, limit: 20 });
      live.push(...found.filter((w) => w.isTradable && hasRoom(w)));
    } catch (e) {
      notes.push(`${asset}: ${e instanceof Error ? e.message.slice(0, 80) : "unreadable"}`);
    }
  }

  if (live.length === 0) {
    return { considered: 0, forecast: 0, placed: 0, passed: 0, skipped: 0, notes };
  }

  // Never forecast the same window twice. The first estimate is the record.
  let seen: Set<string>;
  try {
    seen = await forecastedWindowIds(db, wallet, live.map((w) => w.marketId));
  } catch {
    // If we cannot tell what we have already done, do nothing rather than
    // risk a second call on a window we have already taken a position in.
    return { considered: live.length, forecast: 0, placed: 0, passed: 0, skipped: live.length, notes: ["log unreadable"] };
  }

  const fresh = live.filter((w) => !seen.has(w.marketId));
  // Soonest to close first: that is where a forecast is worth the most and
  // where the market has had the most time to be right.
  fresh.sort((a, b) => a.secondsLeft - b.secondsLeft);

  // Outcome history per asset, fetched once rather than per window.
  const history = new Map<string, Awaited<ReturnType<typeof getResolvedHistory>>>();
  for (const asset of new Set(fresh.map((w) => w.asset))) {
    try {
      history.set(asset, await getResolvedHistory(db, asset, 12));
    } catch {
      history.set(asset, []);
    }
  }

  let forecastCount = 0;
  let placedCount = 0;
  let passedCount = 0;

  for (const window of fresh) {
    if (forecastCount >= maxForecasts) break;

    // Re-check: reads above took real time and the window may have aged out.
    if (!hasRoom(window)) continue;

    let book: { up: bigint | null; down: bigint | null };
    try {
      book = await getTopOfBook(dex, window.pool);
    } catch {
      continue;
    }

    const ctx: WindowContext = {
      asset: window.asset,
      question: window.question,
      intervalSec: window.intervalSec,
      secondsLeft: window.secondsLeft,
      askUpBps: book.up === null ? null : unitsToBps(book.up, decimals),
      askDownBps: book.down === null ? null : unitsToBps(book.down, decimals),
      history: history.get(window.asset) ?? [],
    };

    const result = await forecastWindow(ctx);
    if (!result) {
      notes.push(`${window.asset}: no forecast`);
      continue;
    }
    forecastCount += 1;

    let decision: Decision = decide({ forecast: result.forecast, book, decimals });

    // Budget exhausted: the estimate still stands and is still recorded, but
    // this pass will not act on it. Recorded honestly rather than as NO_EDGE.
    if (decision.kind === "PLACE" && placedCount >= maxPlacements) {
      decision = { kind: "PASS", reason: "BUDGET_SPENT", forecast: decision.forecast, edge: decision.edge, side: decision.side };
    }

    let txHash: string | null = null;

    if (decision.kind === "PLACE") {
      try {
        const quote = await quoteCall(dex, { window, direction: decision.side, stake });
        if (!quote) {
          decision = { kind: "PASS", reason: "NO_BOOK", forecast: decision.forecast, edge: decision.edge, side: decision.side };
        } else {
          const placed = await placeCall(dex, {
            window, direction: decision.side, stake, account: wallet,
          });
          if (placed.filled > 0n) {
            txHash = placed.txHash;
            placedCount += 1;
          } else {
            // The order went out and came back empty. Not a forecast failure.
            decision = { kind: "PASS", reason: "NO_BOOK", forecast: decision.forecast, edge: decision.edge, side: decision.side };
          }
        }
      } catch (e) {
        const code = e instanceof DexError ? e.code : "UNKNOWN";
        notes.push(`${window.asset}: order ${code}`);
        decision =
          code === "WINDOW_CLOSED"
            ? { kind: "PASS", reason: "WINDOW_CLOSING", forecast: decision.forecast, edge: decision.edge, side: decision.side }
            : { kind: "PASS", reason: "NO_BOOK", forecast: decision.forecast, edge: decision.edge, side: decision.side };
      }
    }

    if (decision.kind === "PASS") passedCount += 1;

    // Record either way, and record it LAST — so a row always reflects what
    // actually happened, including an order that failed on the way out.
    try {
      await recordForecast(db, {
        id: forecastId(wallet, window.marketId),
        wallet: wallet.toLowerCase(),
        windowId: window.marketId,
        asset: window.asset,
        probabilityUpBps: result.forecast.probabilityUpBps,
        confidence: result.forecast.confidence,
        rationale: result.forecast.rationale,
        keyFactors: JSON.stringify(result.forecast.keyFactors),
        action: decision.kind,
        passReason: decision.kind === "PASS" ? decision.reason : null,
        side: decision.side,
        askUp: book.up === null ? null : book.up.toString(),
        askDown: book.down === null ? null : book.down.toString(),
        edge: decision.edge.toString(),
        txHash,
        closesAt: new Date(window.closesAtSec * 1000),
        weekId: weekIdForClose(window.closesAtSec),
      });
    } catch (e) {
      notes.push(`log write failed: ${e instanceof Error ? e.message.slice(0, 60) : "unknown"}`);
    }
  }

  return {
    considered: fresh.length,
    forecast: forecastCount,
    placed: placedCount,
    passed: passedCount,
    skipped: live.length - fresh.length,
    notes,
  };
}
