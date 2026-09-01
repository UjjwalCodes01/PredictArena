import { NextResponse } from "next/server";
import {
  getStandings, currentWeekId, getRecentForecasts, getForecastSummary, getWalletCalls,
} from "@predictarena/db";
import { BRIER_COIN_FLIP } from "@predictarena/db";
import { unitsToBps, isConfigured, activeProvider, describeProvider, modelId } from "@predictarena/ai";
import { serverDb, serverDex, aiWallet, dbRead } from "@/lib/server";
import { rateLimit, clientKey, tooManyRequests } from "@/lib/rateLimit";
import { cached } from "@/lib/cache";
import type { AiResponse, ForecastDto } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The forecaster's dossier.
 *
 * Deliberately reports the AI's record from the SAME sources as everyone
 * else's: its rank comes from `getStandings`, which recomputes from raw calls
 * the indexer derived from chain fills. The forecast log adds the reasoning
 * behind each call — but never the result of one.
 *
 * The field comparison is the honest part. If the AI's Brier is worse than the
 * median human's, this endpoint says so, because there is no branch here that
 * could say otherwise.
 */

/** Middle value, or the mean of the middle two. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  return Math.round(value * 1000) / 1000;
}

function parseFactors(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === "string") : [];
  } catch {
    return [];
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  const limit = rateLimit(clientKey(request), { capacity: 40, refillPerSec: 2 });
  if (!limit.ok) return tooManyRequests(limit) as never;

  const weekId = currentWeekId();
  const wallet = aiWallet();
  const configured = isConfigured() && wallet !== null;

  if (!wallet) {
    // Report the provider even with no wallet: on a fresh deploy, "the model
    // is reachable but AI_PRIVATE_KEY is missing" and "nothing is configured
    // at all" are very different problems, and this is where you look.
    const half = activeProvider();
    const body: AiResponse = {
      configured: false,
      provider: half ? describeProvider(half) : null,
      model: half ? modelId() : null,
      wallet: null, weekId, standing: null,
      fieldBrier: null, fieldEdge: null, rankedPlayers: 0,
      summary: { total: 0, placed: 0, passed: 0 }, coinFlipBrier: BRIER_COIN_FLIP, forecasts: [],
    };
    return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
  }

  const lower = wallet.toLowerCase();

  try {
    const db = serverDb();
    const decimals = serverDex().collateral.decimals;

    const [standings, rows, summary, calls] = await Promise.all([
      cached(`standings:${weekId}`, 6_000, () => dbRead(() => getStandings(db, weekId))),
      cached(`ai:forecasts:${lower}`, 5_000, () => dbRead(() => getRecentForecasts(db, lower, 40))),
      cached(`ai:summary:${lower}`, 15_000, () => dbRead(() => getForecastSummary(db, lower))),
      cached(`ai:calls:${lower}`, 5_000, () => dbRead(() => getWalletCalls(db, lower, 200))),
    ]);

    const standing = standings.find((s) => s.wallet.toLowerCase() === lower) ?? null;

    // The field, excluding the AI itself — comparing it to a set containing
    // itself would flatter it as the sample gets small.
    const field = standings.filter((s) => s.wallet.toLowerCase() !== lower);
    const fieldBrier = median(field.map((s) => s.brier).filter((b): b is number => b !== null));
    const fieldEdge = median(field.map((s) => s.edge).filter((e): e is number => e !== null));

    // Outcome comes from `calls` — chain-derived — keyed by window. The
    // forecast row is never consulted for it.
    const outcomeByWindow = new Map<string, "WON" | "LOST" | "VOID" | "PENDING">();
    for (const c of calls) {
      if (c.status === "FAILED") continue;
      const existing = outcomeByWindow.get(c.windowId);
      if (!existing || existing === "PENDING") outcomeByWindow.set(c.windowId, c.status);
    }

    const forecasts: ForecastDto[] = rows.map((r) => ({
      windowId: r.windowId,
      asset: r.asset,
      probabilityUpBps: r.probabilityUpBps,
      confidence: r.confidence as "LOW" | "MEDIUM" | "HIGH",
      rationale: r.rationale,
      keyFactors: parseFactors(r.keyFactors),
      action: r.action,
      passReason: r.passReason,
      side: r.side,
      askUpBps: r.askUp === null ? null : unitsToBps(BigInt(r.askUp), decimals),
      askDownBps: r.askDown === null ? null : unitsToBps(BigInt(r.askDown), decimals),
      edgeBps: r.edge === null ? null : unitsToBps(BigInt(r.edge), decimals),
      txHash: r.txHash,
      closesAtSec: Math.floor(r.closesAt.getTime() / 1000),
      createdAtSec: Math.floor(r.createdAt.getTime() / 1000),
      outcome: r.action === "PLACE" ? (outcomeByWindow.get(r.windowId) ?? null) : null,
    }));

    const active = activeProvider();
    const body: AiResponse = {
      configured,
      provider: active ? describeProvider(active) : null,
      model: active ? modelId() : null,
      wallet,
      weekId,
      standing: standing ? { ...standing, displayName: null } : null,
      fieldBrier,
      fieldEdge,
      rankedPlayers: field.length,
      summary,
      coinFlipBrier: BRIER_COIN_FLIP,
      forecasts,
    };
    return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json(
      {
        code: "API_DOWN",
        message: e instanceof Error ? e.message : "Could not load the forecaster.",
        action: "Retry in a moment.",
      },
      { status: 503 },
    );
  }
}
