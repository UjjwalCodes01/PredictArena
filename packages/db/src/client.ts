/**
 * Database connection.
 *
 * Neon serverless: an HTTP driver, so it works from a Vercel serverless
 * function and from a long-lived indexer process without connection pooling
 * gymnastics. That is the reason we are on Neon rather than a SQLite file --
 * one URL, shared by both, no persistent volume.
 */
import net from "node:net";
import dns from "node:dns";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

/**
 * Make `fetch` able to reach Neon on a network without working IPv6.
 *
 * The Neon pooler publishes both A and AAAA records. Node's `fetch` (undici)
 * uses Happy Eyeballs, which races the addresses in DNS order and allows each
 * only `autoSelectFamilyAttemptTimeout` — **250ms by default** — before moving
 * on. On a host with no IPv6 route, and a link where the TLS handshake to Neon
 * takes longer than that, every attempt is abandoned and the whole connection
 * reports ETIMEDOUT after well under a second. Measured here: a hard failure at
 * ~800ms while `curl` to the same host connected in 300ms, and while raw
 * `net.connect` to each of its IPv4 addresses succeeded.
 *
 * That is a specific, diagnosable failure and it is worth fixing rather than
 * suffering, because it takes down every database read at once — leaderboard,
 * activity, portfolio, health — and looks exactly like "Neon is down".
 *
 * Two adjustments, both process-global and both safe in production:
 *
 *  - IPv4 first, so unroutable AAAA addresses are not tried ahead of addresses
 *    that work. This is an ORDER, not an exclusion: a v6-only host still
 *    connects, just after the v4 attempts fail.
 *  - A longer per-attempt budget. On a healthy network the first address still
 *    wins in milliseconds, so this costs nothing; it only stops a slow link
 *    being misread as an unreachable one.
 *
 * Set `PREDICTARENA_NO_NET_TUNING=1` to skip both.
 */
let tuned = false;
function tuneNetworkStack(): void {
  if (tuned || process.env["PREDICTARENA_NO_NET_TUNING"]) return;
  tuned = true;
  try {
    dns.setDefaultResultOrder("ipv4first");
    net.setDefaultAutoSelectFamilyAttemptTimeout(3_000);
  } catch {
    // Older or unusual runtimes may not expose these. The driver still works
    // wherever IPv6 is healthy, so this must never be fatal.
  }
}

export type Database = ReturnType<typeof createDb>;

export class DbConfigError extends Error {
  readonly code = "DB_CONFIG";
  constructor(message: string, readonly action: string) {
    super(message);
    this.name = "DbConfigError";
  }
}

/**
 * Builds the client. Takes the URL explicitly rather than reading process.env,
 * so this package stays usable from a browser-adjacent runtime and so tests can
 * point it anywhere.
 */
export function createDb(databaseUrl: string) {
  tuneNetworkStack();
  const url = databaseUrl?.trim();
  if (!url) {
    throw new DbConfigError(
      "DATABASE_URL is empty.",
      "Create a Neon project, copy its pooled connection string into .env as DATABASE_URL.",
    );
  }
  if (!/^postgres(ql)?:\/\//.test(url)) {
    throw new DbConfigError(
      `DATABASE_URL does not look like a Postgres URL (starts "${url.slice(0, 12)}").`,
      "Use the connection string Neon shows under Connect, including ?sslmode=require.",
    );
  }
  return drizzle(neon(url), { schema });
}

/**
 * Raw SQL escape hatch, for schema introspection and health checks.
 *
 * Exported from here rather than letting callers import the Neon driver
 * directly, so this package stays the single seam to the database -- the same
 * discipline `packages/dex` applies to DreamDEX.
 */
export function createSql(databaseUrl: string) {
  tuneNetworkStack();
  const url = databaseUrl?.trim();
  if (!url) throw new DbConfigError("DATABASE_URL is empty.", "Set it in .env.");
  return neon(url);
}

export { schema };
