import { NextResponse } from "next/server";
import { serverDex, withDeadline } from "@/lib/server";
import { rateLimit, clientKey, tooManyRequests } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Unclaimed winnings for a wallet.
 *
 * Winnings are CLAIMED, not received: a settled market pays out only when
 * someone asks it to, so a player who never redeems reads near zero while
 * their balance sits across finished windows. Surfacing this is the difference
 * between a game that pays and one that quietly does not.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const limit = rateLimit(clientKey(request), { capacity: 20, refillPerSec: 1 });
  if (!limit.ok) return tooManyRequests(limit) as never;

  const { searchParams } = new URL(request.url);
  const wallet = searchParams.get("wallet");

  if (!wallet || !ADDRESS.test(wallet)) {
    return NextResponse.json({ code: "BAD_REQUEST", message: "A valid wallet is required." }, { status: 400 });
  }

  try {
    const dex = serverDex();
    // 12s: comfortably longer than the 2.5-4s this normally takes, and far
    // enough inside the function limit that a slow venue becomes a message
    // rather than a 504.
    const positions = await withDeadline("getClaimable", 12_000, () =>
      dex.exchange.client.getClaimable(wallet as `0x${string}`),
    );
    const total = positions.reduce((sum, p) => sum + p.estPayout, 0n);
    return NextResponse.json(
      {
        total: total.toString(),
        positions: positions.map((p) => ({
          marketId: p.marketId,
          outcomeIdx: p.outcomeIdx,
          amount: p.amount.toString(),
          estPayout: p.estPayout.toString(),
          status: p.status,
        })),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    // The claim lookup goes through the indexer and does fail transiently. Say
    // so plainly rather than implying the player has nothing to claim.
    return NextResponse.json(
      {
        code: "API_DOWN",
        message: "Could not check for unclaimed winnings just now.",
        action: "Your winnings are safe on-chain. Try again shortly.",
      },
      { status: 503 },
    );
  }
}
