import { NextResponse } from "next/server";
import { getWindow, quoteCall, DexError } from "@predictarena/dex";
import { serverDex } from "@/lib/server";
import { rateLimit, clientKey, tooManyRequests } from "@/lib/rateLimit";
import type { QuoteDto } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Price a stake on one side of one window.
 *
 * Priced server-side against the chain's book so the number the user sees is
 * the number the order will be built from. Note it is still an ESTIMATE: takers
 * pay the fill price, not the price they offered, so the confirmed cost only
 * exists after the fill.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const limit = rateLimit(clientKey(request), { capacity: 15, refillPerSec: 1 });
  if (!limit.ok) return tooManyRequests(limit) as never;

  const { searchParams } = new URL(request.url);
  const marketId = searchParams.get("marketId");
  const direction = searchParams.get("direction");
  const stakeRaw = searchParams.get("stake");

  if (!marketId || (direction !== "UP" && direction !== "DOWN") || !stakeRaw) {
    return NextResponse.json(
      { code: "BAD_REQUEST", message: "marketId, direction (UP|DOWN) and stake are required." },
      { status: 400 },
    );
  }

  let stake: bigint;
  try {
    stake = BigInt(stakeRaw);
  } catch {
    return NextResponse.json(
      { code: "BAD_REQUEST", message: "stake must be an integer in base units." },
      { status: 400 },
    );
  }

  try {
    const dex = serverDex();
    // Read this ONE window, uncached: its on-chain status gates whether an
    // order can be placed at all, and a stale answer here would send someone
    // to sign into a window that has already locked.
    const window = await getWindow(dex, marketId as `0x${string}`);
    if (!window) {
      return NextResponse.json(
        { code: "NO_MARKETS", message: "That window is no longer live.", action: "Pick the next window." },
        { status: 404 },
      );
    }
    if (!window.isTradable) {
      return NextResponse.json(
        { code: "WINDOW_CLOSED", message: "This window has stopped accepting calls.", action: "Roll to the next window." },
        { status: 409 },
      );
    }

    const quote = await quoteCall(dex, { window, direction, stake });
    if (!quote) {
      return NextResponse.json(
        {
          code: "NO_LIQUIDITY",
          message: `No one is currently selling ${direction === "UP" ? "Up" : "Down"} on this window.`,
          action: "Try the other direction, or wait a moment.",
        },
        { status: 409 },
      );
    }

    const body: QuoteDto = {
      direction,
      limitPrice: quote.limitPrice.toString(),
      quantity: quote.quantity.toString(),
      escrow: quote.escrow.toString(),
      maxPayout: quote.maxPayout.toString(),
    };
    return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    const err = e instanceof DexError ? e : null;
    return NextResponse.json(
      {
        code: err?.code ?? "UNKNOWN",
        message: err?.message ?? "Could not price that call.",
        action: err?.action,
      },
      { status: 503 },
    );
  }
}
