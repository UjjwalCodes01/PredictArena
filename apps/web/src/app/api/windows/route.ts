import { NextResponse } from "next/server";
import { getTopOfBook, DexError } from "@predictarena/dex";
import { serverDex, withDeadline } from "@/lib/server";
import { rateLimit, clientKey, tooManyRequests } from "@/lib/rateLimit";
import { cached } from "@/lib/cache";
import { windowsFor } from "@/lib/windows";
import type { WindowsResponse, WindowDto } from "@/lib/types";

/** Live data: never cache. A stale window is a window a user cannot trade. */
export const dynamic = "force-dynamic";
export const revalidate = 0;
/**
 * Long enough to survive a venue outage.
 *
 * When the venue indexer hangs, this route pays its timeout once and then
 * rebuilds the list from the chain. That is slower than the fast path and
 * still far better than the 503 the alternative produces — but the platform
 * default would kill it first.
 */
export const maxDuration = 60;

/**
 * Live Up/Down windows for the feed.
 *
 * Returns the server's chain-corrected clock alongside the windows so the
 * browser can align its countdowns instead of trusting the local clock -- a
 * machine two minutes fast would otherwise show a window as closed while it is
 * still trading (AGENTS.md, timing edge cases).
 */
export async function GET(request: Request): Promise<NextResponse> {
  const limit = rateLimit(clientKey(request), { capacity: 40, refillPerSec: 2 });
  if (!limit.ok) return tooManyRequests(limit) as never;

  const { searchParams } = new URL(request.url);
  const asset = searchParams.get("asset") ?? undefined;
  const intervalSec = searchParams.get("intervalSec");

  try {
    const dex = serverDex();
    const all = await windowsFor(dex, {
      asset,
      intervalSec: intervalSec ? Number(intervalSec) : undefined,
    });
    // The shared cache holds untradable windows too, because the terminal wants
    // them; the feed does not.
    const windows = all.filter((w) => w.isTradable);

    // Price both sides per window, concurrently. A window with no asks is still
    // shown -- it just cannot be called yet, and saying so is better than
    // hiding it.
    const priced: WindowDto[] = await Promise.all(
      windows.map(async (w) => {
        let up: bigint | null = null;
        let down: bigint | null = null;
        try {
          const top = await cached(`top:${w.pool}`, 2_500, () =>
            withDeadline("topOfBook", 8_000, () => getTopOfBook(dex, w.pool)),
          );
          up = top.up;
          down = top.down;
        } catch {
          // A book we cannot read is a book with no quotes, as far as the UI goes.
        }
        return {
          marketId: w.marketId,
          asset: w.asset,
          pool: w.pool,
          question: w.question,
          strike: w.strike,
          intervalSec: w.intervalSec,
          opensAtSec: w.opensAtSec,
          closesAtSec: w.closesAtSec,
          secondsLeft: Math.round(w.secondsLeft),
          status: w.status,
          isTradable: w.isTradable,
          upPrice: up === null ? null : up.toString(),
          downPrice: down === null ? null : down.toString(),
        };
      }),
    );

    const body: WindowsResponse = {
      serverNowSec: dex.clock.nowSec(),
      windows: priced,
    };
    return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    const err = e instanceof DexError ? e : null;
    return NextResponse.json(
      {
        code: err?.code ?? "UNKNOWN",
        message: err?.message ?? (e instanceof Error ? e.message : "Could not load windows."),
        action: err?.action ?? "Retry in a moment.",
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
