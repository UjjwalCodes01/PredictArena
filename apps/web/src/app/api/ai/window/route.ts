import { NextResponse } from "next/server";
import { getForecastForWindow } from "@predictarena/db";
import { unitsToBps } from "@predictarena/ai";
import { serverDb, serverDex, aiWallet, dbRead } from "@/lib/server";
import { rateLimit, clientKey, tooManyRequests } from "@/lib/rateLimit";
import { cached } from "@/lib/cache";

export const dynamic = "force-dynamic";

/**
 * The forecaster's read on ONE window.
 *
 * Its own endpoint rather than a field on `/api/windows`, because the window
 * feed is the hot path of the core flow and must not grow a database query per
 * poll. This one is small, cached, and its absence changes nothing on the page.
 */

const MARKET_ID = /^0x[0-9a-fA-F]{1,64}$/;

export async function GET(request: Request): Promise<NextResponse> {
  const limit = rateLimit(clientKey(request), { capacity: 40, refillPerSec: 2 });
  if (!limit.ok) return tooManyRequests(limit) as never;

  const id = new URL(request.url).searchParams.get("id");
  if (!id || !MARKET_ID.test(id)) {
    return NextResponse.json({ code: "BAD_REQUEST", message: "id must be a market id." }, { status: 400 });
  }

  const wallet = aiWallet();
  if (!wallet) return NextResponse.json({ forecast: null }, { headers: { "cache-control": "no-store" } });

  try {
    const db = serverDb();
    const decimals = serverDex().collateral.decimals;

    const row = await cached(`ai:w:${id}`, 10_000, () =>
      dbRead(() => getForecastForWindow(db, wallet, id)),
    );
    if (!row) return NextResponse.json({ forecast: null }, { headers: { "cache-control": "no-store" } });

    return NextResponse.json(
      {
        forecast: {
          probabilityUpBps: row.probabilityUpBps,
          confidence: row.confidence,
          rationale: row.rationale,
          action: row.action,
          passReason: row.passReason,
          side: row.side,
          edgeBps: row.edge === null ? null : unitsToBps(BigInt(row.edge), decimals),
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    // Optional data. A failure here must never disturb the call flow.
    return NextResponse.json({ forecast: null }, { headers: { "cache-control": "no-store" } });
  }
}
