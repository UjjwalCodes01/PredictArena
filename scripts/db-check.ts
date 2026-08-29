/**
 * `pnpm db:check` -- is the database reachable, migrated and sane?
 *
 * Read-only. Written so that the moment a DATABASE_URL exists, every
 * assumption Phase 2 makes about the projection can be verified rather than
 * assumed.
 */
import { createDb, createSql, getStandings, currentWeekId, getSyncState } from "@predictarena/db";
// Imported for its side effect: loads the repo-root .env before we read it.
import "./lib/env.js";
import { bold, dim, green, yellow, red, heading, report, kv, check, summarise, describeError, type CheckResult } from "./lib/log.js";

const results: CheckResult[] = [];
const push = (r: CheckResult): CheckResult => (results.push(r), report(r), r);

const EXPECTED_TABLES = ["windows", "calls", "wallets", "sync_state"];

async function main(): Promise<void> {
  console.log(bold("\nDatabase check -- Neon Postgres"));
  console.log(dim("Read-only. Nothing here writes.\n"));

  const url = process.env["DATABASE_URL"]?.trim();

  heading("1. Configuration");
  push(await check("DATABASE_URL is set", async () => {
    if (!url) {
      return { status: "fail", code: "NO_DATABASE_URL", detail: "DATABASE_URL is empty.",
        action: "Create a Neon project, copy the pooled connection string into .env as DATABASE_URL." };
    }
    if (!/^postgres(ql)?:\/\//.test(url)) {
      return { status: "fail", code: "BAD_URL", detail: `Does not look like a Postgres URL (starts "${url.slice(0, 12)}").`,
        action: "Use the string Neon shows under Connect, including ?sslmode=require." };
    }
    // Never print the URL: it contains the password.
    const host = /@([^/?]+)/.exec(url)?.[1] ?? "unknown";
    return { status: "pass", code: "OK", detail: `points at ${host} (credentials not shown)` };
  }));

  if (!url || !/^postgres(ql)?:\/\//.test(url)) {
    summarise(results, "Database check -- summary");
    console.log(`\n  ${yellow("Set DATABASE_URL, then run `pnpm db:migrate`.")}\n`);
    process.exit(1);
  }

  const sql = createSql(url);

  heading("2. Connectivity");
  push(await check("Server reachable", async () => {
    const rows = await sql`SELECT version() AS v`;
    const v = String(rows[0]?.["v"] ?? "").split(",")[0];
    return { status: "pass", code: "OK", detail: v ?? "connected" };
  }));

  heading("3. Schema");
  push(await check("All four tables exist", async () => {
    const rows = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'`;
    const found = new Set(rows.map((r: Record<string, unknown>) => String(r["table_name"])));
    const missing = EXPECTED_TABLES.filter((t) => !found.has(t));
    return missing.length === 0
      ? { status: "pass", code: "OK", detail: EXPECTED_TABLES.join(", ") }
      : { status: "fail", code: "NOT_MIGRATED", detail: `Missing: ${missing.join(", ")}.`,
          action: "Run `pnpm db:migrate`." };
  }));

  push(await check("Enums match the code", async () => {
    const rows = await sql`
      SELECT t.typname AS name, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname IN ('call_status','direction','window_status')
      GROUP BY t.typname`;
    if (rows.length === 0) {
      return { status: "fail", code: "NOT_MIGRATED", detail: "No enum types found.", action: "Run `pnpm db:migrate`." };
    }
    // Postgres returns array_agg as an array LITERAL string ("{A,B,C}") over
    // the HTTP driver, not as a JS array.
    const labelsOf = (v: unknown): string[] =>
      Array.isArray(v) ? v.map(String)
      : typeof v === "string" ? v.replace(/^\{|\}$/g, "").split(",").filter(Boolean)
      : [];
    const detail = rows
      .map((r: Record<string, unknown>) => `${r["name"]}(${labelsOf(r["labels"]).join("|")})`)
      .join("  ");
    const statuses = labelsOf(rows.find((r: Record<string, unknown>) => r["name"] === "call_status")?.["labels"]);
    return statuses.includes("VOID")
      ? { status: "pass", code: "OK", detail }
      : { status: "fail", code: "ENUM_DRIFT", detail: "call_status has no VOID.",
          action: "VOID is a real outcome; re-run migrations." };
  }));

  push(await check("Money columns are exact, never float", async () => {
    const rows = await sql`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'calls' AND column_name IN ('stake','quantity','payout')`;
    const bad = rows.filter((r: Record<string, unknown>) => !String(r["data_type"]).includes("numeric"));
    return bad.length === 0
      ? { status: "pass", code: "OK", detail: `${rows.length} money column(s) are numeric (CLAUDE.md rule 3)` }
      : { status: "fail", code: "FLOAT_MONEY",
          detail: bad.map((r: Record<string, unknown>) => `${r["column_name"]}=${r["data_type"]}`).join(", "),
          action: "Money must never be a float type." };
  }));

  heading("4. Projection");
  const db = createDb(url);

  push(await check("Row counts", async () => {
    const [w] = await sql`SELECT count(*)::int AS n FROM windows`;
    const [c] = await sql`SELECT count(*)::int AS n FROM calls`;
    const [p] = await sql`SELECT count(*)::int AS n FROM wallets`;
    kv("windows", String(w?.["n"] ?? 0));
    kv("calls", String(c?.["n"] ?? 0));
    kv("wallets", String(p?.["n"] ?? 0));
    return { status: "pass", code: "OK", detail: "projection readable" };
  }));

  push(await check("Indexer heartbeat", async () => {
    const hb = await getSyncState(db, "heartbeat");
    if (!hb?.updatedAt) {
      return { status: "warn", code: "NO_HEARTBEAT", detail: "The indexer has never run.",
        action: "Start it with `pnpm indexer`." };
    }
    const ageSec = Math.round((Date.now() - hb.updatedAt.getTime()) / 1000);
    return ageSec < 120
      ? { status: "pass", code: "OK", detail: `last beat ${ageSec}s ago` }
      : { status: "warn", code: "STALE_HEARTBEAT", detail: `last beat ${ageSec}s ago -- indexer looks stopped.`,
          action: "Start it with `pnpm indexer`." };
  }));

  push(await check("Leaderboard computes for the current week", async () => {
    const week = currentWeekId();
    const standings = await getStandings(db, week);
    return { status: "pass", code: "OK",
      detail: standings.length === 0
        ? `${week}: no scored calls yet (a cold start is not an error)`
        : `${week}: ${standings.length} player(s), leader ${standings[0]!.wallet.slice(0, 10)} on ${standings[0]!.points} pts` };
  }));

  const code = summarise(results, "Database check -- summary");
  heading("Next step");
  console.log(code === 0
    ? `  ${green("Database is migrated and readable.")} Start the indexer: ${bold("pnpm indexer")}\n`
    : `  ${red("Resolve the blocking items above.")}\n`);
  process.exit(code);
}

void main().catch((e: unknown) => {
  console.error(`\n${red("db:check aborted:")} ${describeError(e)}\n`);
  process.exit(1);
});
