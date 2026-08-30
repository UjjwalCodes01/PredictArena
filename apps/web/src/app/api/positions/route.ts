import { NextResponse } from "next/server";
import { getWalletCalls, normalizeAddress } from "@predictarena/db";
import { serverDb } from "@/lib/server";
import type { CallDto } from "@/lib/types";

export const dynamic = "force-dynamic";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * A wallet's calls, newest first.
 *
 * Read from the projection, which the indexer derives from chain fills. The
 * browser never tells us what it holds -- it only asks about an address, and
 * the address is public information.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const wallet = searchParams.get("wallet");

  if (!wallet || !ADDRESS.test(wallet)) {
    return NextResponse.json(
      { code: "BAD_REQUEST", message: "A valid wallet address is required." },
      { status: 400 },
    );
  }

  try {
    const db = serverDb();
    // Addresses are stored lowercase; wagmi hands back checksum casing.
    const rows = await getWalletCalls(db, normalizeAddress(wallet), 50);

    const calls: CallDto[] = rows.map((r) => ({
      id: r.id,
      wallet: r.wallet,
      windowId: r.windowId,
      asset: r.asset,
      direction: r.direction,
      status: r.status,
      stake: r.stake,
      quantity: r.quantity,
      txHash: r.txHash,
      placedAt: r.placedAt.toISOString(),
      settledAt: r.settledAt ? r.settledAt.toISOString() : null,
      closesAtSec: null,
      intervalSec: null,
      weekId: r.weekId,
    }));

    return NextResponse.json({ calls }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json(
      {
        code: "API_DOWN",
        message: e instanceof Error ? e.message : "Could not load your calls.",
        action: "The scoreboard is temporarily unavailable. Your positions are safe on-chain.",
      },
      { status: 503 },
    );
  }
}
