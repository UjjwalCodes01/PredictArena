import { NextResponse } from "next/server";
import { getTopOfBook, DexError } from "@predictarena/dex";
import { serverDex } from "@/lib/server";
import { cached } from "@/lib/cache";
import { windowsFor } from "@/lib/windows";

export const dynamic = "force-dynamic";

/**
 * Everything the terminal draws, in one request.
 *
 * Batched deliberately: four separate round trips would let the panels
 * disagree with each other -- a price from one instant beside a book from
 * another reads as a glitch even when both are correct.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const asset = (searchParams.get("asset") ?? "BTC").toUpperCase();
  const marketId = searchParams.get("marketId");

  try {
    const dex = serverDex();
    const client = dex.exchange.client;

    // Same key the feed uses, so the two pages warm each other.
    const windows = await windowsFor(dex, { asset });
    const tradable = windows.filter((w) => w.isTradable);
    const chosen =
      (marketId ? windows.find((w) => w.marketId === marketId) : undefined) ??
      tradable[0] ??
      windows[0];

    // Underlying price: the real-world signal the window resolves against.
    const [live, history] = await Promise.all([
      cached(`price:${asset}`, 2_500, () => client.fetchPrice(asset)).catch(() => null),
      // History moves once a minute; there is no reason to refetch it every 5s.
      cached(`hist:${asset}`, 20_000, () => client.fetchPriceHistory(asset, { limit: 90 })).catch(
        () => [] as unknown[],
      ),
    ]);

    let book = { yesBids: [], yesAsks: [], noBids: [], noAsks: [] } as {
      yesBids: Array<{ price: bigint; quantity: bigint }>;
      yesAsks: Array<{ price: bigint; quantity: bigint }>;
      noBids: Array<{ price: bigint; quantity: bigint }>;
      noAsks: Array<{ price: bigint; quantity: bigint }>;
    };
    let top: { up: bigint | null; down: bigint | null } = { up: null, down: null };
    let trades: Array<{ t: number; price: string; quantity: string }> = [];

    if (chosen) {
      const [b, t, fills] = await Promise.all([
        cached(`book:${chosen.pool}`, 2_500, () => client.getBinaryOrderBook(chosen.pool, { depth: 8 })).catch(() => book),
        cached(`top:${chosen.pool}`, 2_500, () => getTopOfBook(dex, chosen.pool)).catch(() => top),
        cached(`fills:${chosen.pool}`, 5_000, () => client.getFills(chosen.pool, { limit: 120 })).catch(() => []),
      ]);
      book = b;
      top = t;
      trades = fills
        .map((f) => ({ t: Number(f.timestamp), price: f.fillPrice, quantity: f.quantity }))
        .sort((x, y) => x.t - y.t);
    }

    const priceSeries = (Array.isArray(history) ? history : [])
      .map((h) => {
        const row = h as { price?: number; blockTimestamp?: number; timestamp?: number };
        return { t: Number(row.blockTimestamp ?? row.timestamp ?? 0), v: Number(row.price ?? 0) };
      })
      .filter((p) => Number.isFinite(p.v) && p.v > 0)
      .sort((a, b) => a.t - b.t);

    return NextResponse.json(
      {
        serverNowSec: dex.clock.nowSec(),
        asset,
        live: live ? { price: (live as { price?: number }).price ?? null } : null,
        priceSeries,
        window: chosen
          ? {
              marketId: chosen.marketId,
              asset: chosen.asset,
              intervalSec: chosen.intervalSec,
              strike: chosen.strike,
              opensAtSec: chosen.opensAtSec,
              closesAtSec: chosen.closesAtSec,
              secondsLeft: Math.round(chosen.secondsLeft),
              status: chosen.status,
              isTradable: chosen.isTradable,
              question: chosen.question,
              upPrice: top.up ? top.up.toString() : null,
              downPrice: top.down ? top.down.toString() : null,
            }
          : null,
        windows: windows.map((w) => ({
          marketId: w.marketId,
          intervalSec: w.intervalSec,
          secondsLeft: Math.round(w.secondsLeft),
          isTradable: w.isTradable,
        })),
        book: {
          yesBids: book.yesBids.map((l) => ({ price: l.price.toString(), quantity: l.quantity.toString() })),
          yesAsks: book.yesAsks.map((l) => ({ price: l.price.toString(), quantity: l.quantity.toString() })),
        },
        trades,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    const err = e instanceof DexError ? e : null;
    return NextResponse.json(
      {
        code: err?.code ?? "UNKNOWN",
        message: err?.message ?? "Telemetry unavailable.",
        action: err?.action ?? "Retry in a moment.",
      },
      { status: 503 },
    );
  }
}
