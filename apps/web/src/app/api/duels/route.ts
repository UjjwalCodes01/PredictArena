import { NextResponse } from "next/server";
import { verifyMessage } from "viem";
import {
  createDuel, getDuelsForWallet, getCallsForDuels, resolveDuel, tallyDuels, contestKey,
  DuelError, type DuelOutcome,
} from "@predictarena/db";
import { serverDb, serverDex, dbRead, withDeadline } from "@/lib/server";
import { getWindow } from "@predictarena/dex";
import { weekIdForClose } from "@predictarena/db";
import { rateLimit, clientKey, tooManyRequests } from "@/lib/rateLimit";
import { challengeMessage, signatureStaleness } from "@/lib/signedMessage";

export const dynamic = "force-dynamic";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

// The signed text and its freshness rule live in ONE shared module — see
// `@/lib/signedMessage` for why both halves must come from the same place.

/**
 * Duels for one wallet, resolved.
 *
 * Outcomes are computed here from the calls table rather than stored, so a
 * duel can never disagree with the leaderboard it is drawn from.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const limit = rateLimit(clientKey(request), { capacity: 30, refillPerSec: 1 });
  if (!limit.ok) return tooManyRequests(limit) as never;

  const { searchParams } = new URL(request.url);
  const wallet = searchParams.get("wallet");
  if (!wallet || !ADDRESS.test(wallet)) {
    return NextResponse.json({ code: "BAD_REQUEST", message: "A valid wallet is required." }, { status: 400 });
  }

  try {
    const db = serverDb();
    const rows = await dbRead(() => getDuelsForWallet(db, wallet, 25));

    if (rows.length === 0) {
      return NextResponse.json(
        { duels: [], record: { won: 0, lost: 0, drawn: 0, open: 0, expired: 0 } },
        { headers: { "cache-control": "no-store" } },
      );
    }

    // One query for every duel's calls, not one per duel.
    const callRows = await dbRead(() =>
      getCallsForDuels(
        db,
        rows.map((r) => r.windowId),
        rows.flatMap((r) => [r.challenger, r.opponent]),
      ),
    );

    const nowSec = Math.floor(Date.now() / 1000);

    // Collapse a mutual challenge to one entry. Rows created before that was
    // prevented at write time still exist, and showing the same contest twice
    // would look like a bug to the person reading it.
    const seenContest = new Set<string>();
    const unique = rows.filter((r) => {
      const key = contestKey(r.challenger, r.opponent, r.windowId);
      if (seenContest.has(key)) return false;
      seenContest.add(key);
      return true;
    });

    const resolved = unique.map((r) => {
      const outcome: DuelOutcome = resolveDuel(
        {
          challenger: r.challenger,
          opponent: r.opponent,
          windowId: r.windowId,
          closesAtSec: Math.floor(r.closesAt.getTime() / 1000),
          calls: callRows
            .filter((c) => c.windowId === r.windowId)
            .map((c) => ({
              wallet: c.wallet,
              status: c.status,
              direction: c.direction,
              placedAtSec: Math.floor(c.placedAt.getTime() / 1000),
              id: c.id,
            })),
        },
        nowSec,
      );
      return { row: r, outcome };
    });

    return NextResponse.json(
      {
        duels: resolved.map(({ row, outcome }) => ({
          id: row.id,
          challenger: row.challenger,
          opponent: row.opponent,
          windowId: row.windowId,
          asset: row.asset,
          intervalSec: row.intervalSec,
          closesAtSec: Math.floor(row.closesAt.getTime() / 1000),
          createdAt: row.createdAt.toISOString(),
          state: outcome.state,
          result: outcome.result,
          challengerStatus: outcome.challengerCall?.status ?? null,
          opponentStatus: outcome.opponentCall?.status ?? null,
        })),
        record: tallyDuels(
          wallet,
          resolved.map(({ row, outcome }) => ({
            challenger: row.challenger,
            opponent: row.opponent,
            // Lets the tally collapse a mutual challenge into one contest.
            windowId: row.windowId,
            outcome,
          })),
        ),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json(
      { code: "API_DOWN", message: e instanceof Error ? e.message.slice(0, 120) : "Could not load duels." },
      { status: 503 },
    );
  }
}

/**
 * Issue a challenge.
 *
 * The signature is the authorisation: without it anyone could issue challenges
 * in someone else's name, which is spam with a stranger's identity attached.
 * Nothing about the OUTCOME is accepted here — only who is challenging whom.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const limit = rateLimit(`duel:${clientKey(request)}`, { capacity: 10, refillPerSec: 0.2 });
  if (!limit.ok) return tooManyRequests(limit) as never;

  let body: {
    challenger?: string; opponent?: string; windowId?: string; signature?: string; issuedAt?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ code: "BAD_REQUEST", message: "Expected JSON." }, { status: 400 });
  }

  const { challenger, opponent, windowId, signature, issuedAt } = body;
  if (
    !challenger || !ADDRESS.test(challenger) ||
    !opponent || !ADDRESS.test(opponent) ||
    !windowId || !/^0x[0-9a-fA-F]{2,80}$/.test(windowId) ||
    !signature
  ) {
    return NextResponse.json(
      { code: "BAD_REQUEST", message: "challenger, opponent, windowId and signature are all required." },
      { status: 400 },
    );
  }

  // Before the signature check, so a stale timestamp names its actual cause.
  const stale = signatureStaleness(issuedAt);
  if (stale) {
    return NextResponse.json(
      { code: "SIGNATURE_EXPIRED", message: stale, action: "Sign the challenge again." },
      { status: 401 },
    );
  }

  let valid = false;
  try {
    valid = await verifyMessage({
      address: challenger as `0x${string}`,
      // Timestamp included: a signature must not be refreshable by re-posting
      // it with a newer issuedAt.
      message: challengeMessage(challenger, opponent, windowId, issuedAt as string),
      signature: signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }

  if (!valid) {
    return NextResponse.json(
      {
        code: "BAD_SIGNATURE",
        message: "That signature does not match the challenge.",
        action: "Sign again with the wallet issuing the challenge.",
      },
      { status: 401 },
    );
  }

  try {
    // Read the window from the CHAIN, not from a client claim, so a challenge
    // works even while the indexer is behind — otherwise a window visible in
    // the UI could not be challenged on, which reads as the feature being
    // broken rather than the projection being late.
    let windowFallback: Parameters<typeof createDuel>[1]["windowFallback"];
    try {
      const w = await withDeadline("getWindow", 12_000, () =>
        getWindow(serverDex(), windowId as `0x${string}`),
      );
      if (w) {
        windowFallback = {
          closesAt: new Date(w.closesAtSec * 1000),
          opensAt: new Date(w.opensAtSec * 1000),
          weekId: weekIdForClose(w.closesAtSec),
          asset: w.asset,
          pool: w.pool,
        };
      }
    } catch {
      // Chain unreachable: fall through and let the projection answer. If it
      // has the window the challenge still works.
    }

    const { id } = await createDuel(serverDb(), {
      challenger,
      opponent,
      windowId,
      ...(windowFallback ? { windowFallback } : {}),
    });
    return NextResponse.json({ id }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof DuelError) {
      return NextResponse.json({ code: e.code, message: e.message }, { status: 409 });
    }
    return NextResponse.json({ code: "API_DOWN", message: "Could not create that challenge." }, { status: 503 });
  }
}
