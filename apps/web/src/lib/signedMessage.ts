/**
 * The exact texts a wallet signs, and the freshness rule applied to them.
 *
 * ONE home, imported by both the signing client and the verifying server.
 * These used to live twice — a copy in the route, a copy in the component,
 * with a comment begging them to stay identical. A signature scheme whose
 * two halves are maintained by hand is a scheme that fails on the first
 * refactor, so now there is nothing to keep in sync.
 *
 * Deliberately dependency-free: client components import this, and pulling a
 * server package into it would drag database code toward the browser bundle.
 *
 * Every message binds the address AND every field being written, so a
 * signature is tied to specific content. It also carries `Issued at:` — a
 * captured signature used to be replayable forever, because nothing in the
 * text said WHEN it was signed. The damage was bounded (replaying could only
 * repeat the same write), but "bounded" is not "none": a profile signature
 * lifted from a log could keep resurrecting an old bio indefinitely. Now the
 * server refuses anything older than the TTL, so a leaked signature goes
 * stale like a session does.
 */

/** How long a signature stays acceptable after signing. */
export const SIGNATURE_TTL_MS = 10 * 60 * 1000;

/**
 * Forward slack for a client clock that runs fast. Small on purpose: it
 * widens the replay window by exactly this much.
 */
const MAX_SKEW_MS = 2 * 60 * 1000;

const lower = (a: string): string => a.toLowerCase();

export interface ProfileFields {
  displayName?: string | null;
  bio?: string | null;
  twitter?: string | null;
  website?: string | null;
}

export function profileMessage(address: string, p: ProfileFields, issuedAt: string): string {
  return [
    "Prediction Leagues",
    "",
    `Update the profile for ${lower(address)}.`,
    "",
    `name: ${p.displayName ?? ""}`,
    `bio: ${p.bio ?? ""}`,
    `x: ${p.twitter ?? ""}`,
    `web: ${p.website ?? ""}`,
    "",
    `Issued at: ${issuedAt}`,
    "This is a signature, not a transaction. It costs nothing and moves nothing.",
  ].join("\n");
}

export function challengeMessage(
  challenger: string,
  opponent: string,
  windowId: string,
  issuedAt: string,
): string {
  return [
    "Prediction Leagues",
    "",
    `Challenge ${lower(opponent)} on window ${windowId}.`,
    `Issued by ${lower(challenger)}.`,
    "",
    `Issued at: ${issuedAt}`,
    "This is a signature, not a transaction. It costs nothing and moves nothing.",
  ].join("\n");
}

/**
 * Why a signature's timestamp is unacceptable, or null when it is fine.
 *
 * Returned as prose because it goes straight into the error response — the
 * player whose clock is wrong deserves to be told that, not "bad signature".
 */
export function signatureStaleness(issuedAt: unknown): string | null {
  if (typeof issuedAt !== "string" || issuedAt === "") {
    return "The signature is missing its issued-at timestamp.";
  }
  const t = new Date(issuedAt).getTime();
  if (Number.isNaN(t)) {
    return "The signature's issued-at timestamp is not a valid date.";
  }
  const age = Date.now() - t;
  if (age > SIGNATURE_TTL_MS) {
    return "That signature has expired. Sign again.";
  }
  if (age < -MAX_SKEW_MS) {
    return "That signature is dated in the future. Check your device clock and sign again.";
  }
  return null;
}
