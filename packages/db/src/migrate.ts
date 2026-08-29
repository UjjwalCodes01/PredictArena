/**
 * `pnpm db:migrate` -- apply pending migrations to Neon.
 *
 * Uses the plain Postgres driver rather than the HTTP one: migrations run in a
 * transaction, which the serverless HTTP driver does not support.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { neon } from "@neondatabase/serverless";

const DIR = resolve(import.meta.dirname, "..", "drizzle");

// The workspace keeps one .env at the repo root; this package is two levels down.
loadDotenv({ path: resolve(import.meta.dirname, "..", "..", "..", ".env"), quiet: true });

function fail(message: string, action: string): never {
  console.error(`\n  Migration failed: ${message}`);
  console.error(`  -> ${action}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"]?.trim();
  if (!url) {
    fail("DATABASE_URL is not set.", "Add your Neon connection string to .env as DATABASE_URL.");
  }
  if (!existsSync(DIR)) {
    fail(`No migrations at ${DIR}.`, "Run `pnpm db:generate` first.");
  }

  const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
  if (files.length === 0) fail("No .sql migrations found.", "Run `pnpm db:generate` first.");

  const sql = neon(url);

  // A tiny ledger of what has been applied. Drizzle Kit keeps its own, but this
  // stays readable and makes a partial apply obvious.
  await sql`CREATE TABLE IF NOT EXISTS _migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;
  const applied = new Set((await sql`SELECT name FROM _migrations`).map((r) => String(r["name"])));

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  skip  ${file} (already applied)`);
      continue;
    }
    const body = readFileSync(resolve(DIR, file), "utf8");
    // Drizzle separates statements with this marker.
    const statements = body.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
    console.log(`  apply ${file} (${statements.length} statement(s))`);
    for (const statement of statements) {
      await sql.query(statement);
    }
    await sql`INSERT INTO _migrations (name) VALUES (${file})`;
    count += 1;
  }

  console.log(count === 0 ? "\n  Already up to date.\n" : `\n  Applied ${count} migration(s).\n`);
  process.exit(0);
}

void main().catch((e: unknown) => {
  fail(e instanceof Error ? e.message : String(e), "Check DATABASE_URL and the Neon project status.");
});
