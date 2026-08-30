import { NextResponse } from "next/server";
import { verifyMessage } from "viem";
import {
  saveProfile, getWallet, DisplayNameError, normalizeAddress, type ProfileInput,
} from "@predictarena/db";
import { serverDb, dbRead } from "@/lib/server";
import { rateLimit, clientKey, tooManyRequests } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The exact text a player signs to update their profile.
 *
 * It contains the address AND every field being written, so a signature is
 * bound to specific content. Signing "name: alice" cannot be replayed to set a
 * different name or to slip in a website the signer never saw.
 *
 * Both sides build this string from the same function, so they cannot drift.
 */
export function profileMessage(address: string, p: ProfileInput): string {
  const lines = [
    "Prediction Leagues",
    "",
    `Update the profile for ${normalizeAddress(address)}.`,
    "",
    `name: ${p.displayName ?? ""}`,
    `bio: ${p.bio ?? ""}`,
    `x: ${p.twitter ?? ""}`,
    `web: ${p.website ?? ""}`,
    "",
    "This is a signature, not a transaction. It costs nothing and moves nothing.",
  ];
  return lines.join("\n");
}

export async function GET(request: Request): Promise<NextResponse> {
  const limit = rateLimit(clientKey(request), { capacity: 20, refillPerSec: 1 });
  if (!limit.ok) return tooManyRequests(limit) as never;

  const { searchParams } = new URL(request.url);
  const wallet = searchParams.get("wallet");
  if (!wallet || !ADDRESS.test(wallet)) {
    return NextResponse.json({ code: "BAD_REQUEST", message: "A valid wallet is required." }, { status: 400 });
  }
  try {
    const row = await dbRead(() => getWallet(serverDb(), wallet));
    return NextResponse.json(
      {
        address: normalizeAddress(wallet),
        displayName: row?.displayName ?? null,
        bio: row?.bio ?? null,
        twitter: row?.twitter ?? null,
        website: row?.website ?? null,
        firstSeenAt: row?.firstSeenAt ? row.firstSeenAt.toISOString() : null,
        profileUpdatedAt: row?.profileUpdatedAt ? row.profileUpdatedAt.toISOString() : null,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ code: "API_DOWN", message: "Could not load that profile." }, { status: 503 });
  }
}

/**
 * Save a profile.
 *
 * The signature is the authorisation. AGENTS.md section 5: the server trusts
 * nothing the client merely asserts, so nothing is written until the message
 * has been verified against the address it claims to be. Without this, anyone
 * could write anyone's profile -- including putting a link on a rival's page.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const limit = rateLimit(clientKey(request), { capacity: 20, refillPerSec: 1 });
  if (!limit.ok) return tooManyRequests(limit) as never;

  let body: { address?: string; profile?: ProfileInput; signature?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ code: "BAD_REQUEST", message: "Expected JSON." }, { status: 400 });
  }

  const { address, profile, signature } = body;
  if (!address || !ADDRESS.test(address) || !profile || !signature) {
    return NextResponse.json(
      { code: "BAD_REQUEST", message: "address, profile and signature are all required." },
      { status: 400 },
    );
  }

  let valid = false;
  try {
    valid = await verifyMessage({
      address: address as `0x${string}`,
      // Rebuilt from what was SENT, so the signature covers exactly the values
      // about to be stored.
      message: profileMessage(address, profile),
      signature: signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }

  if (!valid) {
    return NextResponse.json(
      {
        code: "BAD_SIGNATURE",
        message: "That signature does not match the address and details.",
        action: "Sign again with the wallet you are editing.",
      },
      { status: 401 },
    );
  }

  try {
    await saveProfile(serverDb(), address, profile);
    const row = await getWallet(serverDb(), address);
    return NextResponse.json({
      address: normalizeAddress(address),
      displayName: row?.displayName ?? null,
      bio: row?.bio ?? null,
      twitter: row?.twitter ?? null,
      website: row?.website ?? null,
    });
  } catch (e) {
    if (e instanceof DisplayNameError) {
      return NextResponse.json(
        { code: e.code, message: e.message, action: e.code === "TAKEN" ? "Pick another name." : undefined },
        { status: 409 },
      );
    }
    return NextResponse.json({ code: "API_DOWN", message: "Could not save your profile." }, { status: 503 });
  }
}
