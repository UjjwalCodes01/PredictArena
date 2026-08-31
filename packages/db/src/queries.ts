/**
 * Data access. Every write is an idempotent upsert.
 *
 * That is not tidiness -- it is what makes indexer recovery a restart rather
 * than a repair. Replaying the same settlement, or the same transaction, must
 * converge on the same row, because the reconciler will do exactly that every
 * 45 seconds and again on every startup.
 */
import { and, desc, eq, gte, inArray, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import type { Database } from "./client";
import { calls, wallets, windows, duels, syncState } from "./schema";
import type { NewCallRow, NewWindowRow, CallRow, WindowRow } from "./schema";
import { computeStandings } from "./scoring";
import type { CallStatus, ScorableCall, Standing, Direction } from "./types";

/** Statuses that will never change again. Everything else is the reconciler's job. */
export const TERMINAL_STATUSES: readonly CallStatus[] = ["WON", "LOST", "VOID", "FAILED"];

const secondsOf = (d: Date): number => Math.floor(d.getTime() / 1000);

/** Upsert a window. Safe to replay: chain values always overwrite ours. */
export async function upsertWindow(db: Database, row: NewWindowRow): Promise<void> {
  await db
    .insert(windows)
    .values(row)
    .onConflictDoUpdate({
      target: windows.id,
      set: {
        status: row.status ?? sql`excluded.status`,
        strike: sql`excluded.strike`,
        winningOutcome: sql`excluded.winning_outcome`,
        resolvedAt: sql`excluded.resolved_at`,
        updatedAt: new Date(),
      },
    });
}

/**
 * Record a call. Keyed on `tx_hash`, so ingesting the same transaction twice
 * updates rather than duplicates.
 */
/**
 * Write many calls in ONE statement. See `touchWallets` for why.
 *
 * Chunked, because a single statement with thousands of rows can exceed the
 * driver's parameter limit — a failure that only shows up under exactly the
 * load where batching matters most.
 */
export async function upsertCalls(db: Database, rows: readonly NewCallRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const CHUNK = 100;
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await db
      .insert(calls)
      .values([...chunk])
      .onConflictDoUpdate({
        target: [calls.txHash, calls.windowId, calls.direction],
        set: {
          status: sql`excluded.status`,
          quantity: sql`excluded.quantity`,
          settledAt: sql`excluded.settled_at`,
          payout: sql`excluded.payout`,
          redeemTxHash: sql`excluded.redeem_tx_hash`,
          updatedAt: new Date(),
        },
      });
    written += chunk.length;
  }
  return written;
}

/**
 * Write many windows in ONE statement.
 *
 * Same reason as `upsertCalls`: the per-row version costs a round trip each,
 * and ingest writes ~23 of them per pass. Against a database an ocean away
 * that alone was ~6s, and it pushed the serverless ingest leg past its
 * deadline.
 */
export async function upsertWindows(db: Database, rows: readonly NewWindowRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const CHUNK = 100;
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await db
      .insert(windows)
      .values([...chunk])
      .onConflictDoUpdate({
        target: windows.id,
        set: {
          status: sql`excluded.status`,
          strike: sql`excluded.strike`,
          winningOutcome: sql`excluded.winning_outcome`,
          resolvedAt: sql`excluded.resolved_at`,
          pool: sql`excluded.pool`,
          updatedAt: new Date(),
        },
      });
    written += chunk.length;
  }
  return written;
}

export async function upsertCall(db: Database, row: NewCallRow): Promise<void> {
  await db
    .insert(calls)
    .values(row)
    .onConflictDoUpdate({
      target: [calls.txHash, calls.windowId, calls.direction],
      set: {
        status: sql`excluded.status`,
        quantity: sql`excluded.quantity`,
        settledAt: sql`excluded.settled_at`,
        payout: sql`excluded.payout`,
        redeemTxHash: sql`excluded.redeem_tx_hash`,
        updatedAt: new Date(),
      },
    });
}

/**
 * Apply a settlement to every call on a window.
 *
 * Derived server-side from the window's outcome -- never from anything a client
 * posted (AGENTS.md section 5: the client never says "I won").
 */
export async function settleCallsForWindow(
  db: Database,
  params: { windowId: string; winningOutcome: number | null; voided: boolean; settledAt: Date },
): Promise<number> {
  const { windowId, winningOutcome, voided, settledAt } = params;

  // Refuse to guess. An earlier version wrote
  //   winningOutcome === 0 ? "UP" : "DOWN"
  // which silently treated a NULL outcome as "Down won" -- marking every Up
  // call LOST and every Down call WON on a window whose result we did not
  // actually know. Fabricating results is worse than settling nothing, so an
  // outcome that is neither 0 nor 1 is an error, not a default.
  if (!voided && winningOutcome !== 0 && winningOutcome !== 1) {
    throw new Error(
      `settleCallsForWindow(${windowId}): winningOutcome must be 0 or 1 when not voided, got ${String(winningOutcome)}`,
    );
  }

  const status = voided
    ? sql`'VOID'::call_status`
    : sql`CASE WHEN ${calls.direction} = ${winningOutcome === 0 ? "UP" : "DOWN"}
                THEN 'WON'::call_status ELSE 'LOST'::call_status END`;

  const updated = await db
    .update(calls)
    .set({ status, settledAt, updatedAt: new Date() })
    .where(and(eq(calls.windowId, windowId), eq(calls.status, "PENDING")))
    .returning({ id: calls.id });

  return updated.length;
}

/**
 * Record a settlement on a window that ALREADY exists.
 *
 * An UPDATE, deliberately not an upsert: the reconciler knows a window id but
 * not the window's asset or week, so an upsert would insert a stub row with
 * empty fields and quietly poison the projection. If the row is missing, that
 * is an ingestion gap to fix, not a hole to paper over -- so we report it.
 */
export async function markWindowSettled(
  db: Database,
  params: { windowId: string; winningOutcome: number | null; voided: boolean; resolvedAt: Date },
): Promise<boolean> {
  const updated = await db
    .update(windows)
    .set({
      status: params.voided ? "VOIDED" : "RESOLVED",
      winningOutcome: params.voided ? null : params.winningOutcome,
      resolvedAt: params.resolvedAt,
      updatedAt: new Date(),
    })
    .where(eq(windows.id, params.windowId))
    .returning({ id: windows.id });
  return updated.length > 0;
}

/**
 * Calls that are still non-terminal -- the reconciler's work list.
 *
 * Paged rather than capped. A bare `limit` silently drops everything past it,
 * and the calls that get dropped are precisely the ones a restart is supposed
 * to recover: the guarantee would quietly stop applying above a threshold
 * nobody was watching.
 */
export async function getNonTerminalCalls(db: Database, maxRows = 20_000): Promise<CallRow[]> {
  return pageAll((offset, size) =>
    db.select().from(calls).where(eq(calls.status, "PENDING"))
      .orderBy(calls.placedAt).limit(size).offset(offset),
    maxRows,
  );
}

const PAGE = 500;

/** Reads every row in pages, stopping at `maxRows` as a runaway guard. */
async function pageAll<T>(
  fetch: (offset: number, size: number) => Promise<T[]>,
  maxRows: number,
): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; offset < maxRows; offset += PAGE) {
    const page = await fetch(offset, Math.min(PAGE, maxRows - offset));
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

/**
 * Pending calls whose window has already closed -- these are overdue for a
 * settlement and are what the 45s poller chases.
 */
export async function getOverdueCalls(db: Database, now: Date, maxRows = 20_000): Promise<CallRow[]> {
  const rows = await pageAll((offset, size) =>
    db.select({ call: calls })
      .from(calls)
      .innerJoin(windows, eq(calls.windowId, windows.id))
      .where(and(eq(calls.status, "PENDING"), lt(windows.closesAt, now)))
      .orderBy(windows.closesAt)
      .limit(size).offset(offset),
    maxRows,
  );
  return rows.map((r) => r.call);
}

/** Windows that have not reached a terminal state. */
export async function getOpenWindows(db: Database, limit = 200): Promise<WindowRow[]> {
  return db
    .select()
    .from(windows)
    .where(or(eq(windows.status, "OPEN"), eq(windows.status, "LOCKED")))
    .orderBy(desc(windows.closesAt))
    .limit(limit);
}

/**
 * Addresses are stored LOWERCASE, everywhere.
 *
 * Chain reads return them lowercase; wagmi and viem hand back EIP-55 checksum
 * casing. Storing one and querying with the other silently matches nothing, so
 * every address crossing this boundary is normalised. Display code re-applies
 * checksum casing at the edge.
 */
export const normalizeAddress = (address: string): string => address.trim().toLowerCase();

/**
 * Record many wallets in ONE statement.
 *
 * The per-wallet version costs a round trip each, and ingestion calls it once
 * per call it writes. Against a database an ocean away that dominated
 * everything: two sequential round trips per call, ~500ms, so sixty calls took
 * thirty seconds and the serverless ingest leg timed out having written
 * nothing. Batching turns that into one statement.
 */
export async function touchWallets(db: Database, addresses: readonly string[]): Promise<void> {
  const unique = [...new Set(addresses.map(normalizeAddress))];
  if (unique.length === 0) return;
  const now = new Date();
  await db
    .insert(wallets)
    .values(unique.map((address) => ({ address, firstSeenAt: now, lastSeenAt: now })))
    .onConflictDoUpdate({ target: wallets.address, set: { lastSeenAt: now } });
}

export async function touchWallet(db: Database, address: string): Promise<void> {
  const now = new Date();
  await db
    .insert(wallets)
    .values({ address: normalizeAddress(address), firstSeenAt: now, lastSeenAt: now })
    .onConflictDoUpdate({ target: wallets.address, set: { lastSeenAt: now } });
}

/** Display-name rules. Deliberately narrow: a name is a label, not a bio. */
export const DISPLAY_NAME_RE = /^[a-zA-Z0-9_-]{3,20}$/;

export class DisplayNameError extends Error {
  constructor(readonly code: "INVALID" | "TAKEN", message: string) {
    super(message);
    this.name = "DisplayNameError";
  }
}

/**
 * Claim a display name for an address.
 *
 * The CALLER is responsible for having verified a signature from this address
 * first -- this function trusts its arguments, and the API route in front of it
 * is where ownership is proved (AGENTS.md: the server trusts nothing the client
 * merely asserts).
 */
export async function setDisplayName(db: Database, address: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!DISPLAY_NAME_RE.test(trimmed)) {
    throw new DisplayNameError(
      "INVALID",
      "Names are 3-20 characters, letters, numbers, hyphen or underscore.",
    );
  }
  const wallet = normalizeAddress(address);
  const now = new Date();
  try {
    await db
      .insert(wallets)
      .values({ address: wallet, displayName: trimmed, displayNameSetAt: now, firstSeenAt: now, lastSeenAt: now })
      .onConflictDoUpdate({
        target: wallets.address,
        set: { displayName: trimmed, displayNameSetAt: now, lastSeenAt: now },
      });
  } catch (e) {
    // The unique index is the arbiter, not a prior lookup: checking first would
    // race two people claiming the same name at once.
    if (String(e).includes("wallets_display_name_uidx")) {
      throw new DisplayNameError("TAKEN", `"${trimmed}" is already taken.`);
    }
    throw e;
  }
}

/**
 * Everything a player may write about themselves.
 *
 * Deliberately small. A league profile is a label and two links, not a social
 * network, and every extra free-text field is another thing to moderate.
 */
export interface ProfileInput {
  displayName?: string | null;
  bio?: string | null;
  twitter?: string | null;
  website?: string | null;
}

export const BIO_MAX = 160;
const TWITTER_RE = /^[A-Za-z0-9_]{1,15}$/;

/**
 * Validate and normalise a profile.
 *
 * Runs on the SERVER, never in the browser: client-side validation is a
 * convenience for the user, not a control (AGENTS.md -- the server trusts
 * nothing the client asserts).
 */
export function normalizeProfile(input: ProfileInput): ProfileInput {
  const out: ProfileInput = {};

  if (input.displayName !== undefined) {
    const v = (input.displayName ?? "").trim();
    if (v === "") out.displayName = null;
    else if (!DISPLAY_NAME_RE.test(v)) {
      throw new DisplayNameError("INVALID", "Names are 3-20 characters: letters, numbers, hyphen or underscore.");
    } else out.displayName = v;
  }

  if (input.bio !== undefined) {
    const v = (input.bio ?? "").trim();
    if (v.length > BIO_MAX) {
      throw new DisplayNameError("INVALID", `A bio is at most ${BIO_MAX} characters.`);
    }
    out.bio = v === "" ? null : v;
  }

  if (input.twitter !== undefined) {
    // Accept what people paste -- a URL, an @handle -- and store the handle.
    const raw = (input.twitter ?? "").trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "").replace(/\/$/, "");
    if (raw === "") out.twitter = null;
    else if (!TWITTER_RE.test(raw)) {
      throw new DisplayNameError("INVALID", "That does not look like an X handle.");
    } else out.twitter = raw;
  }

  if (input.website !== undefined) {
    const v = (input.website ?? "").trim();
    if (v === "") out.website = null;
    else {
      // If the input carries ANY scheme, it must be one we allow. Only a
      // scheme-less input gets https:// prepended.
      //
      // Prepending unconditionally was a bug: "file:///etc/passwd" became
      // "https://file:///etc/passwd", which parses cleanly and passed the
      // protocol check -- silently storing mangled input instead of refusing
      // it. Detect the scheme first, then decide.
      const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(v);
      if (hasScheme && !/^https?:\/\//i.test(v)) {
        throw new DisplayNameError("INVALID", "Only http and https addresses are allowed.");
      }

      let url: URL;
      try {
        url = new URL(hasScheme ? v : `https://${v}`);
      } catch {
        throw new DisplayNameError("INVALID", "That does not look like a web address.");
      }
      // Belt and braces: the parsed protocol must still be one we allow.
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new DisplayNameError("INVALID", "Only http and https addresses are allowed.");
      }
      if (!url.hostname || !url.hostname.includes(".")) {
        throw new DisplayNameError("INVALID", "That does not look like a web address.");
      }
      if (url.href.length > 200) {
        throw new DisplayNameError("INVALID", "That web address is too long.");
      }
      out.website = url.href;
    }
  }

  return out;
}

/**
 * Save a profile.
 *
 * The CALLER must have verified a signature from this address first. This
 * function trusts its arguments; the API route in front of it is where
 * ownership is proved.
 */
export async function saveProfile(db: Database, address: string, input: ProfileInput): Promise<void> {
  const clean = normalizeProfile(input);
  const wallet = normalizeAddress(address);
  const now = new Date();

  const set: Record<string, unknown> = { lastSeenAt: now, profileUpdatedAt: now };
  if (clean.displayName !== undefined) { set["displayName"] = clean.displayName; set["displayNameSetAt"] = now; }
  if (clean.bio !== undefined) set["bio"] = clean.bio;
  if (clean.twitter !== undefined) set["twitter"] = clean.twitter;
  if (clean.website !== undefined) set["website"] = clean.website;

  try {
    await db
      .insert(wallets)
      .values({
        address: wallet,
        firstSeenAt: now,
        lastSeenAt: now,
        profileUpdatedAt: now,
        ...(clean.displayName !== undefined ? { displayName: clean.displayName, displayNameSetAt: now } : {}),
        ...(clean.bio !== undefined ? { bio: clean.bio } : {}),
        ...(clean.twitter !== undefined ? { twitter: clean.twitter } : {}),
        ...(clean.website !== undefined ? { website: clean.website } : {}),
      })
      .onConflictDoUpdate({ target: wallets.address, set });
  } catch (e) {
    // The unique index arbitrates, not a prior lookup: checking first would
    // race two people claiming one name.
    if (String(e).includes("wallets_display_name_uidx")) {
      throw new DisplayNameError("TAKEN", `"${clean.displayName}" is already taken.`);
    }
    throw e;
  }
}

export async function getWallet(db: Database, address: string) {
  const [row] = await db
    .select()
    .from(wallets)
    .where(eq(wallets.address, normalizeAddress(address)))
    .limit(1);
  return row ?? null;
}

/** Display names for a batch of addresses, so a list needs one query not N. */
export async function getDisplayNames(
  db: Database,
  addresses: readonly string[],
): Promise<Map<string, string>> {
  if (addresses.length === 0) return new Map();
  const rows = await db
    .select({ address: wallets.address, displayName: wallets.displayName })
    .from(wallets)
    .where(inArray(wallets.address, addresses.map(normalizeAddress)));
  const out = new Map<string, string>();
  for (const r of rows) if (r.displayName) out.set(r.address, r.displayName);
  return out;
}

/** Why a challenge was refused. The UI switches on these. */
export class DuelError extends Error {
  constructor(readonly code: "SELF" | "WINDOW_CLOSED" | "NO_WINDOW" | "EXISTS", message: string) {
    super(message);
    this.name = "DuelError";
  }
}

/** Stable id, so issuing the same challenge twice is one row, not two. */
export function duelId(challenger: string, opponent: string, windowId: string): string {
  return `${normalizeAddress(challenger)}:${normalizeAddress(opponent)}:${windowId}`;
}

/**
 * Record a challenge.
 *
 * The CALLER must have verified a signature from the challenger first. This
 * writes no outcome — who won is derived from calls at read time.
 */
export async function createDuel(
  db: Database,
  params: { challenger: string; opponent: string; windowId: string },
): Promise<{ id: string }> {
  const challenger = normalizeAddress(params.challenger);
  const opponent = normalizeAddress(params.opponent);

  if (challenger === opponent) {
    throw new DuelError("SELF", "You cannot challenge yourself.");
  }

  const [window] = await db
    .select({ id: windows.id, closesAt: windows.closesAt, weekId: windows.weekId })
    .from(windows)
    .where(eq(windows.id, params.windowId))
    .limit(1);

  if (!window) {
    throw new DuelError("NO_WINDOW", "That window is not one we know about yet.");
  }
  // A challenge on a closed window can never be accepted, so refusing it up
  // front is kinder than letting it expire the moment it is made.
  if (window.closesAt.getTime() <= Date.now()) {
    throw new DuelError("WINDOW_CLOSED", "That window has already closed.");
  }

  const id = duelId(challenger, opponent, params.windowId);
  await db
    .insert(duels)
    .values({
      id,
      challenger,
      opponent,
      windowId: params.windowId,
      closesAt: window.closesAt,
      weekId: window.weekId,
    })
    // Re-issuing the same challenge is a no-op rather than an error: the user
    // tapping twice means the same thing both times.
    .onConflictDoNothing({ target: duels.id });

  return { id };
}

export interface DuelRow {
  id: string;
  challenger: string;
  opponent: string;
  windowId: string;
  closesAt: Date;
  weekId: string;
  createdAt: Date;
  asset: string | null;
  intervalSec: number | null;
}

/**
 * Every duel a wallet is part of, newest first, with the window's asset joined
 * so the UI can name it without a second query.
 */
export async function getDuelsForWallet(
  db: Database,
  wallet: string,
  limit = 25,
): Promise<DuelRow[]> {
  const w = normalizeAddress(wallet);
  const rows = await db
    .select({
      id: duels.id,
      challenger: duels.challenger,
      opponent: duels.opponent,
      windowId: duels.windowId,
      closesAt: duels.closesAt,
      weekId: duels.weekId,
      createdAt: duels.createdAt,
      asset: windows.asset,
      intervalSec: windows.intervalSec,
    })
    .from(duels)
    .leftJoin(windows, eq(duels.windowId, windows.id))
    .where(or(eq(duels.challenger, w), eq(duels.opponent, w)))
    .orderBy(desc(duels.createdAt))
    .limit(Math.min(limit, 100));
  return rows;
}

/**
 * Calls on the given windows by the given wallets — everything needed to
 * resolve a batch of duels in one query rather than one per duel.
 */
export async function getCallsForDuels(
  db: Database,
  windowIds: readonly string[],
  wallets: readonly string[],
): Promise<Array<{ wallet: string; windowId: string; status: CallStatus; direction: Direction; placedAt: Date; id: string }>> {
  if (windowIds.length === 0 || wallets.length === 0) return [];
  return db
    .select({
      wallet: calls.wallet,
      windowId: calls.windowId,
      status: calls.status,
      direction: calls.direction,
      placedAt: calls.placedAt,
      id: calls.id,
    })
    .from(calls)
    .where(
      and(
        inArray(calls.windowId, [...new Set(windowIds)]),
        inArray(calls.wallet, [...new Set(wallets.map(normalizeAddress))]),
      ),
    );
}

export async function getSyncState(db: Database, key: string) {
  const [row] = await db.select().from(syncState).where(eq(syncState.key, key)).limit(1);
  return row ?? null;
}

export async function setSyncState(
  db: Database,
  key: string,
  value: { blockNumber?: bigint; cursor?: string },
): Promise<void> {
  await db
    .insert(syncState)
    .values({ key, blockNumber: value.blockNumber ?? null, cursor: value.cursor ?? null, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: syncState.key,
      set: { blockNumber: sql`excluded.block_number`, cursor: sql`excluded.cursor`, updatedAt: new Date() },
    });
}

/** Raw calls for a week, shaped for the pure scoring engine. */
export async function getScorableCalls(db: Database, weekId: string): Promise<ScorableCall[]> {
  const rows = await db
    .select({
      id: calls.id,
      wallet: calls.wallet,
      windowId: calls.windowId,
      direction: calls.direction,
      status: calls.status,
      placedAt: calls.placedAt,
      weekId: calls.weekId,
      closesAt: windows.closesAt,
      // Together these give the price paid per contract, which is the
      // probability the call asserted. Needed for Brier and edge.
      stake: calls.stake,
      quantity: calls.quantity,
    })
    .from(calls)
    .innerJoin(windows, eq(calls.windowId, windows.id))
    .where(eq(calls.weekId, weekId));

  return rows.map((r) => ({
    id: r.id,
    wallet: r.wallet,
    windowId: r.windowId,
    direction: r.direction,
    status: r.status,
    // Numerics arrive as strings from the driver; money stays bigint.
    stake: BigInt(r.stake ?? "0"),
    quantity: BigInt(r.quantity ?? "0"),
    placedAtSec: secondsOf(r.placedAt),
    closesAtSec: secondsOf(r.closesAt),
    weekId: r.weekId,
  }));
}

/**
 * The leaderboard.
 *
 * Deliberately computed from raw calls on every read rather than stored: points
 * are derived data, so a reorg or a late correction is a recompute, not a
 * repair. At league scale this is a small query and a pure function.
 */
export async function getStandings(db: Database, weekId: string): Promise<Standing[]> {
  return computeStandings(await getScorableCalls(db, weekId), weekId);
}

/** Every call a wallet has made, newest first. Powers the profile page. */
export async function getWalletCalls(db: Database, wallet: string, limit = 100): Promise<CallRow[]> {
  return db
    .select()
    .from(calls)
    .where(eq(calls.wallet, normalizeAddress(wallet)))
    .orderBy(desc(calls.placedAt))
    .limit(limit);
}

/**
 * Recent calls across every player, newest first.
 *
 * Powers the activity feed. Joined to windows so the caller gets the asset and
 * close time without a second round trip.
 */
export async function getRecentCalls(
  db: Database,
  opts: { limit?: number; settledOnly?: boolean } = {},
): Promise<Array<CallRow & { closesAt: Date; intervalSec: number | null }>> {
  const limit = Math.min(opts.limit ?? 40, 200);
  const rows = await db
    .select({ call: calls, closesAt: windows.closesAt, intervalSec: windows.intervalSec })
    .from(calls)
    .innerJoin(windows, eq(calls.windowId, windows.id))
    .where(opts.settledOnly ? ne(calls.status, "PENDING") : undefined)
    .orderBy(desc(calls.settledAt), desc(calls.placedAt))
    .limit(limit);
  return rows.map((r) => ({ ...r.call, closesAt: r.closesAt, intervalSec: r.intervalSec }));
}

/** Headline counters for the home and activity pages. */
export async function getLeagueTotals(db: Database, weekId: string): Promise<{
  players: number;
  calls: number;
  settled: number;
  volume: string;
}> {
  const [row] = await db
    .select({
      players: sql<number>`count(distinct ${calls.wallet})::int`,
      calls: sql<number>`count(*)::int`,
      settled: sql<number>`count(*) filter (where ${calls.status} <> 'PENDING')::int`,
      // Sum as numeric and hand back a string: an amount must never round-trip
      // through a JSON number.
      volume: sql<string>`coalesce(sum(${calls.stake}), 0)::text`,
    })
    .from(calls)
    .where(eq(calls.weekId, weekId));
  return row ?? { players: 0, calls: 0, settled: 0, volume: "0" };
}

/**
 * Windows that closed recently and whose fills may not all be ingested.
 *
 * The venue drops settled windows from its live list within minutes, so the
 * normal ingest cycle cannot see them. This is the catch-up list: anything that
 * closed in the recent past and for which we hold a pool address, so its fills
 * can still be read directly.
 */
export async function getRecentlyClosedWindows(
  db: Database,
  sinceMinutes = 180,
): Promise<Array<{ id: string; pool: string; asset: string; intervalSec: number | null; closesAt: Date }>> {
  const cutoff = new Date(Date.now() - sinceMinutes * 60_000);
  const rows = await db
    .select({
      id: windows.id, pool: windows.pool, asset: windows.asset,
      intervalSec: windows.intervalSec, closesAt: windows.closesAt,
    })
    .from(windows)
    .where(and(gte(windows.closesAt, cutoff), isNotNull(windows.pool)))
    .orderBy(desc(windows.closesAt))
    .limit(200);
  return rows.filter((r): r is typeof r & { pool: string } => r.pool !== null);
}

/** Windows by id, for reconciling a batch of calls in one round trip. */
export async function getWindowsByIds(db: Database, ids: readonly string[]): Promise<WindowRow[]> {
  if (ids.length === 0) return [];
  return db.select().from(windows).where(inArray(windows.id, [...ids]));
}
