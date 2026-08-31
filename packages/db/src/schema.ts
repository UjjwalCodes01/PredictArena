/**
 * Database schema. Neon serverless Postgres via Drizzle.
 *
 * The DB is a PROJECTION of chain truth, never a source of it (AGENTS.md
 * section 3). Every row here is re-derivable from the chain plus the window it
 * refers to, and on any disagreement the chain wins and the row is corrected.
 * Nothing is ever "fixed" here by hand.
 *
 * Two deviations from PLAN.md's sketch, both deliberate:
 *
 *  1. `stake` is `numeric(78,0)`, not a float or an int8. Amounts are bigint end
 *     to end (CLAUDE.md hard rule 3); numeric comes back from pg as a string, so
 *     a value can never silently become a float on the way out.
 *
 *  2. The uniqueness constraint is on `tx_hash`, NOT on (wallet, window_id).
 *     PLAN.md suggested the latter, but a wallet is genuinely allowed to place
 *     several calls on one window on-chain -- a unique key there would reject
 *     legitimate rows. The one-per-window rule is a SCORING cap, enforced by the
 *     pure engine, so here it is only an index.
 */
import { sql } from "drizzle-orm";
import {
  pgTable, pgEnum, text, integer, bigint, numeric, timestamp, index, uniqueIndex, primaryKey,
} from "drizzle-orm/pg-core";

/** Position status. VOID is a first-class outcome, not an error. */
export const callStatus = pgEnum("call_status", ["PENDING", "WON", "LOST", "VOID", "FAILED"]);
export const direction = pgEnum("direction", ["UP", "DOWN"]);
/** Window lifecycle, mirroring the on-chain status we actually observe. */
export const windowStatus = pgEnum("window_status", ["OPEN", "LOCKED", "RESOLVED", "VOIDED"]);

/**
 * One Up/Down window. `id` is the on-chain marketId -- never the pool address,
 * because pools are recycled across windows.
 */
export const windows = pgTable(
  "windows",
  {
    id: text("id").primaryKey(),
    asset: text("asset").notNull(),
    venueId: text("venue_id"),
    /**
     * The market's pool address.
     *
     * Stored so fills stay reachable AFTER the venue drops a settled window
     * from its live list. Without it, a window that closed while the indexer
     * was down becomes unreadable and every call placed on it is lost.
     */
    pool: text("pool"),
    intervalSec: integer("interval_sec"),
    /** Reference price the outcome is measured against; 0 until the window opens. */
    strike: numeric("strike", { precision: 78, scale: 0 }),
    opensAt: timestamp("opens_at", { withTimezone: true }).notNull(),
    closesAt: timestamp("closes_at", { withTimezone: true }).notNull(),
    status: windowStatus("status").notNull().default("OPEN"),
    /** 0 = Up, 1 = Down. Null while unresolved or when voided. */
    winningOutcome: integer("winning_outcome"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /**
     * ISO week of the CLOSE time, computed once at insert. A call inherits this,
     * so a window cannot drift between weeks after the fact.
     */
    weekId: text("week_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("windows_asset_closes_idx").on(t.asset, t.closesAt),
    index("windows_week_idx").on(t.weekId),
    index("windows_status_idx").on(t.status),
  ],
);

/**
 * A wallet's call on a window.
 *
 * `stake` and `quantity` are base units of the collateral (tUSDC, 6dp) held as
 * numeric so they round-trip as exact integers.
 */
export const calls = pgTable(
  "calls",
  {
    id: text("id").primaryKey(),
    wallet: text("wallet").notNull(),
    windowId: text("window_id").notNull().references(() => windows.id),
    asset: text("asset").notNull(),
    direction: direction("direction").notNull(),
    /** Collateral escrowed, base units. */
    stake: numeric("stake", { precision: 78, scale: 0 }).notNull(),
    /** Outcome contracts actually filled, base units. */
    quantity: numeric("quantity", { precision: 78, scale: 0 }).notNull().default("0"),
    txHash: text("tx_hash").notNull(),
    /**
     * PENDING until the window settles. FAILED is reserved for Phase 3's
     * optimistic rows: a rejected order produces no fill, so the indexer can
     * never create one -- it exists so the UI can record an attempt that never
     * became a position, rather than leaving a phantom PENDING row.
     */
    status: callStatus("status").notNull().default("PENDING"),
    placedAt: timestamp("placed_at", { withTimezone: true }).notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    /**
     * Redemption. Both stay NULL until a winner claims -- winnings are claimed,
     * not received, so a settled call is not a paid call. Written by the claim
     * flow in a later phase; the indexer never fills these in.
     */
    payout: numeric("payout", { precision: 78, scale: 0 }),
    redeemTxHash: text("redeem_tx_hash"),
    /** Inherited from the window's close time. Decided once, never recomputed. */
    weekId: text("week_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Ingest idempotency. Keyed on (tx_hash, window_id, direction).
    //
    // Not tx_hash alone: one order can sweep several price levels and produce
    // several fills sharing a transaction -- those are ONE call, because the
    // user tapped once.
    //
    // And not (tx_hash, direction) either, which was the previous key: a single
    // batch transaction can trade two different windows in the same direction,
    // and those two calls would have collided, silently overwriting one another
    // and losing a player's entry.
    uniqueIndex("calls_tx_window_direction_uidx").on(t.txHash, t.windowId, t.direction),
    // NOT unique: several calls on one window are legal on-chain. The
    // one-per-window rule is a scoring cap, not a storage constraint.
    index("calls_wallet_window_idx").on(t.wallet, t.windowId),
    index("calls_week_status_idx").on(t.weekId, t.status),
    // The reconciler's hot path: everything still non-terminal.
    index("calls_status_idx").on(t.status),
    index("calls_wallet_idx").on(t.wallet),
  ],
);

/** A participant. The wallet address IS the identity -- no accounts, no passwords. */
/**
 * A head-to-head challenge: two wallets, one window.
 *
 * This table records only the CHALLENGE — who challenged whom, on which
 * window. It deliberately stores no outcome. Who won is derived from the
 * `calls` table, which the indexer derives from chain fills, so a duel result
 * cannot drift from the calls it is made of and there is nothing here for a
 * client to lie about.
 *
 * The same anti-farming rule the leaderboard uses applies: each side's earliest
 * call on the window is the one that counts.
 */
export const duels = pgTable(
  "duels",
  {
    /** `${challenger}:${opponent}:${windowId}` — makes a repeat challenge a no-op. */
    id: text("id").primaryKey(),
    challenger: text("challenger").notNull(),
    opponent: text("opponent").notNull(),
    windowId: text("window_id").notNull(),
    /** Copied from the window at creation, so expiry needs no join. */
    closesAt: timestamp("closes_at", { withTimezone: true }).notNull(),
    weekId: text("week_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("duels_challenger_idx").on(t.challenger),
    index("duels_opponent_idx").on(t.opponent),
    index("duels_window_idx").on(t.windowId),
    index("duels_week_idx").on(t.weekId),
  ],
);

export const wallets = pgTable(
  "wallets",
  {
    address: text("address").primaryKey(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * Optional display name.
     *
     * The wallet address remains the identity -- there are no accounts and no
     * passwords (AGENTS.md non-goals). A name is a label on top of it, and it
     * can only be set by someone who signed a message proving they hold the
     * key, so it cannot be squatted on another player's behalf.
     */
    displayName: text("display_name"),
    displayNameSetAt: timestamp("display_name_set_at", { withTimezone: true }),
    /**
     * Self-authored profile fields.
     *
     * All optional, all length-capped, and all written only after a signature
     * from this address has been verified. Stored as plain text and escaped at
     * render time -- nothing here is ever treated as markup.
     */
    bio: text("bio"),
    /** Handle only, no leading @ and no URL: we build the link ourselves. */
    twitter: text("twitter"),
    /** Absolute http(s) URL. Any other scheme is rejected before it is stored. */
    website: text("website"),
    profileUpdatedAt: timestamp("profile_updated_at", { withTimezone: true }),
  },
  (t) => [
    // Case-insensitive uniqueness: "Alice" and "alice" must not be two players.
    uniqueIndex("wallets_display_name_uidx").on(sql`lower(${t.displayName})`),
  ],
);

/**
 * Indexer cursors and heartbeats. Keyed by name so a new worker can add its own
 * without a migration.
 */
export const syncState = pgTable(
  "sync_state",
  {
    key: text("key").notNull(),
    blockNumber: bigint("block_number", { mode: "bigint" }),
    cursor: text("cursor"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.key] })],
);

export type WindowRow = typeof windows.$inferSelect;
export type NewWindowRow = typeof windows.$inferInsert;
export type CallRow = typeof calls.$inferSelect;
export type NewCallRow = typeof calls.$inferInsert;
export type WalletRow = typeof wallets.$inferSelect;
export type SyncStateRow = typeof syncState.$inferSelect;
