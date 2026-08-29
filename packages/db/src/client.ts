/**
 * Database connection.
 *
 * Neon serverless: an HTTP driver, so it works from a Vercel serverless
 * function and from a long-lived indexer process without connection pooling
 * gymnastics. That is the reason we are on Neon rather than a SQLite file --
 * one URL, shared by both, no persistent volume.
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema.js";

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
  const url = databaseUrl?.trim();
  if (!url) throw new DbConfigError("DATABASE_URL is empty.", "Set it in .env.");
  return neon(url);
}

export { schema };
