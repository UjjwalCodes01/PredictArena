import { NextResponse } from "next/server";
import { verifyMessage } from "viem";
import {
  setDisplayName, getWallet, DisplayNameError, normalizeAddress,
} from "@predictarena/db";
import { serverDb } from "@/lib/server";

export const dynamic = "force-dynamic";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The exact text a claimant signs. Includes the address so a signature
 *  captured for one name cannot be replayed to claim another. */
export function claimMessage(address: string, name: string): string {
  return `Prediction Leagues\n\nClaim the name "${name}" for ${normalizeAddress(address)}.\n\nThis is a signature, not a transaction. It costs nothing and moves nothing.`;
}

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const wallet = searchParams.get("wallet");
  if (!wallet || !ADDRESS.test(wallet)) {
    return NextResponse.json({ code: "BAD_REQUEST", message: "A valid wallet is required." }, { status: 400 });
  }
  try {
    const row = await getWallet(serverDb(), wallet);
    return NextResponse.json(
      {
        address: normalizeAddress(wallet),
        displayName: row?.displayName ?? null,
        firstSeenAt: row?.firstSeenAt ? row.firstSeenAt.toISOString() : null,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ code: "API_DOWN", message: "Could not load that profile." }, { status: 503 });
  }
}

/**
 * Claim a display name.
 *
 * The signature is the whole point. AGENTS.md section 5: the server trusts
 * nothing the client merely asserts, so a name is only written after the
 * message has been verified against the address that is claiming it. Without
 * this anyone could name anyone -- including taking a rival's handle on the
 * leaderboard.
 *
 * A signature costs nothing and moves nothing, which is why this is not a
 * transaction.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let body: { address?: string; name?: string; signature?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ code: "BAD_REQUEST", message: "Expected JSON." }, { status: 400 });
  }

  const { address, name, signature } = body;
  if (!address || !ADDRESS.test(address) || !name || !signature) {
    return NextResponse.json(
      { code: "BAD_REQUEST", message: "address, name and signature are all required." },
      { status: 400 },
    );
  }

  let valid = false;
  try {
    valid = await verifyMessage({
      address: address as `0x${string}`,
      message: claimMessage(address, name),
      signature: signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }

  if (!valid) {
    return NextResponse.json(
      {
        code: "BAD_SIGNATURE",
        message: "That signature does not match the address.",
        action: "Sign the message with the wallet you are naming.",
      },
      { status: 401 },
    );
  }

  try {
    await setDisplayName(serverDb(), address, name);
    return NextResponse.json({ address: normalizeAddress(address), displayName: name.trim() });
  } catch (e) {
    if (e instanceof DisplayNameError) {
      return NextResponse.json(
        { code: e.code, message: e.message, action: e.code === "TAKEN" ? "Pick another name." : undefined },
        { status: 409 },
      );
    }
    return NextResponse.json({ code: "API_DOWN", message: "Could not save that name." }, { status: 503 });
  }
}
