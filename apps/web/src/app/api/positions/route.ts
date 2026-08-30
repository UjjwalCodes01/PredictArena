import { NextResponse } from "next/server";
import { getWalletCalls, getSyncState, normalizeAddress } from "@predictarena/db";
import { serverDb, dbRead } from "@/lib/server";
import { rateLimit, clientKey, tooManyRequests } from "@/lib/rateLimit";
import { cached } from "@/lib/cache";
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
  const limit = rateLimit(clientKey(request), { capacity: 40, refillPerSec: 2 });
  if (!limit.ok) return tooManyRequests(limit) as never;

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
    const key = normalizeAddress(wallet);
    const [rows, heartbeat] = await Promise.all([
      cached(`calls:${key}`, 5_000, () => dbRead(() => getWalletCalls(db, key, 50))),
      // The indexer writes a heartbeat every 30s. If it has stopped, this
      // endpoint would otherwise return an empty list that looks exactly like
      // "you have not placed any calls" -- which is a lie to someone who just
      // did. Report the staleness so the UI can say so.
      cached("heartbeat", 10_000, () => dbRead(() => getSyncState(db, "heartbeat"))).catch(() => null),
    ]);

    const cursor = (heartbeat as { cursor?: string } | null)?.cursor;
    const indexerAgeSec = cursor
      ? Math.max(0, Math.round((Date.now() - new Date(cursor).getTime()) / 1000))
      : null;

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

    return NextResponse.json(
      { calls, indexerAgeSec },
      { headers: { "cache-control": "no-store" } },
    );
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
