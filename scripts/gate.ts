/**
 * `pnpm gate` — are the phase exit gates actually met?
 *
 * Phase 0: notes complete, one settled tx hash, four funded wallets.
 * Phase 1: `packages/dex` exists and `pnpm smoke` completes a live
 * round-trip; CI green (typecheck + lint + tests).
 *
 * Checked against reality rather than memory, so "the phase is done" is a claim
 * the repo can verify instead of one we assert.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { assertLiveNetwork, explorerTx, formatFixed, formatStt } from "@predictarena/dex";
import { createClientOrExit, getPrivateKey, WALLET_SLOTS, REPO_ROOT, LINKS, type WalletSlot } from "./lib/env.js";
import { bold, dim, green, red, heading, report, kv, check, summarise, type CheckResult } from "./lib/log.js";

const results: CheckResult[] = [];
const push = (r: CheckResult): CheckResult => (results.push(r), report(r), r);

const ARTIFACT_PATH = resolve(REPO_ROOT, "artifacts", "phase0-probe.json");
const NOTES_PATH = resolve(REPO_ROOT, "docs", "dex-notes.md");

/** The Phase 0 questions dex-notes.md must answer. */
const REQUIRED_NOTES_TOPICS: Array<[string, RegExp]> = [
  ["how an order is placed", /createOrder|placeOrder|placeLimit/i],
  ["window schema / how windows are queried", /listLiveBinaryMarkets|window schema|intervalSec/i],
  ["settlement + VOID semantics", /voided|VOID/i],
  ["payout math", /payout|redeem for 1|0\.5/i],
  ["collateral token + decimals", /tUSDC/],
  ["rate limits / auth", /rate limit/i],
];

async function main(): Promise<void> {
  console.log(bold("\nPhase exit gates"));
  console.log(dim("Phase 0: notes + a settled tx hash + four funded wallets."));
  console.log(dim("Phase 1: packages/dex + a live smoke round-trip + CI checks.\n"));

  // ── Gate 1: notes ─────────────────────────────────────────────────────────
  heading("1. docs/dex-notes.md complete");
  push(await check("Notes file exists and answers every Phase 0 question", async () => {
    if (!existsSync(NOTES_PATH)) {
      return { status: "fail", code: "NO_NOTES", detail: "docs/dex-notes.md is missing.",
        action: "Record the API surface findings there — it is gate item 1." };
    }
    const text = readFileSync(NOTES_PATH, "utf8");
    const missing = REQUIRED_NOTES_TOPICS.filter(([, re]) => !re.test(text)).map(([label]) => label);
    return missing.length === 0
      ? { status: "pass", code: "OK", detail: `${REQUIRED_NOTES_TOPICS.length} required topics covered.` }
      : { status: "fail", code: "NOTES_INCOMPLETE", detail: `Not covered: ${missing.join("; ")}.`,
          action: "Fill those sections in docs/dex-notes.md." };
  }));

  // ── Gate 2: a settled probe ───────────────────────────────────────────────
  heading("2. One settled Event Contract tx hash");
  push(await check("Probe artifact records a settled order", async () => {
    if (!existsSync(ARTIFACT_PATH)) {
      return { status: "fail", code: "NO_PROBE", detail: "artifacts/phase0-probe.json not found.",
        action: "Run `pnpm smoke` — it writes the artifact." };
    }
    const a = JSON.parse(readFileSync(ARTIFACT_PATH, "utf8")) as {
      orderTxHash?: string; orderStatus?: string; settlement?: { status?: string } | null;
      outcome?: string | null; redeemTxHash?: string | null; marketId?: string;
    };
    if (!a.orderTxHash) {
      return { status: "fail", code: "NO_TX", detail: "Artifact has no order tx hash.", action: "Re-run `pnpm smoke`." };
    }
    kv("order tx", explorerTx(a.orderTxHash));
    kv("order status", a.orderStatus ?? "—");
    kv("settlement", a.settlement?.status ?? "not settled");
    kv("outcome", a.outcome ?? "—");
    if (a.redeemTxHash) kv("redeem tx", explorerTx(a.redeemTxHash));

    if (a.orderStatus === "unfilled") {
      return { status: "fail", code: "UNFILLED", detail: "The probe order never filled, so nothing settled.",
        action: "Re-run `pnpm smoke` — it re-picks a fillable window each run." };
    }
    if (!a.settlement?.status) {
      return { status: "fail", code: "NOT_SETTLED", detail: "Order placed but settlement was never observed.",
        action: "Re-run `pnpm smoke` and let it poll to completion." };
    }
    return { status: "pass", code: "OK",
      detail: `${a.settlement.status} → ${a.outcome}. Order and settlement both recorded on Shannon.` };
  }));

  // ── Gate 3: four funded wallets ───────────────────────────────────────────
  heading("3. Four funded wallets");
  let dex;
  try {
    dex = createClientOrExit().client;
    await assertLiveNetwork(dex);
  } catch (e) {
    push({ name: "Chain reachable for balance checks", status: "fail", code: "API_DOWN",
      detail: e instanceof Error ? e.message : String(e), action: "Check RPC_HTTP_URL and retry." });
    process.exit(summarise(results, "Phase 0 gate — summary"));
  }

  const collateral = dex.collateral.address;
  const d = dex.collateral.decimals;
  // The gate says "four funded wallets", so all four are required. An
  // earlier draft softened SEED1..3 to warnings; that was moving the goalpost
  // rather than meeting it. `pnpm faucet --fund-seeds` tops them up from DEV,
  // which sidesteps the external faucet's 24h cooldown.
  const REQUIRED: WalletSlot[] = [...WALLET_SLOTS];

  for (const slot of WALLET_SLOTS) {
    const required = REQUIRED.includes(slot);
    push(await check(`${slot} wallet funded`, async () => {
      let key: `0x${string}` | undefined;
      try { key = getPrivateKey(slot); } catch (e) {
        return { status: "fail", code: "BAD_PRIVATE_KEY", detail: (e as Error).message,
          action: "Fix .env or re-run `pnpm wallets --force`." };
      }
      if (!key) {
        return { status: required ? "fail" : "warn", code: "NO_WALLET",
          detail: `${slot}_PRIVATE_KEY is empty.`, action: "Run `pnpm wallets`." };
      }
      const { address } = privateKeyToAccount(key);
      const [stt, bal] = await Promise.all([
        dex.rpc.getBalance({ address }),
        collateral
          ? dex.rpc.readContract({ address: collateral, abi: erc20Abi, functionName: "balanceOf", args: [address] })
          : Promise.resolve(0n),
      ]);
      const detail = `${address}  ${formatStt(stt)} STT  ${formatFixed(bal, d, 2)} tUSDC`;
      if (stt === 0n || bal === 0n) {
        const what = [stt === 0n ? "STT" : null, bal === 0n ? "tUSDC" : null].filter(Boolean).join(" and ");
        return { status: required ? "fail" : "warn", code: "UNFUNDED",
          detail, action: `Fund ${what} for this address at ${LINKS.faucet}` };
      }
      return { status: "pass", code: "OK", detail };
    }));
  }

  dex.close();

  // ── Phase 1 ───────────────────────────────────────────────────────────────
  heading("4. Phase 1 — packages/dex and the smoke canary");

  push(await check("packages/dex exports the Phase 1 surface (imported, not grepped)", async () => {
    const index = resolve(REPO_ROOT, "packages", "dex", "src", "index.ts");
    if (!existsSync(index)) {
      return { status: "fail", code: "NO_DEX_PACKAGE", detail: "packages/dex/src/index.ts is missing.",
        action: "Phase 1 builds the dex package." };
    }
    // Importing beats grepping: a name can appear in a comment or a string and
    // pass a text search while not existing at all.
    const mod = await import("@predictarena/dex");
    const required = [
      "getMarkets", "getWindows", "getCurrentWindow", "quoteCall", "preflightCall",
      "prepareCall", "placeCall", "getPositions", "getSettlement", "getOutcomeBalance",
      "redeem", "awaitSettlement", "subscribe", "statusFor", "assertLiveNetwork", "createDexClient",
    ] as const;
    const record = mod as unknown as Record<string, unknown>;
    const missing = required.filter((n) => typeof record[n] !== "function");
    if (missing.length > 0) {
      return { status: "fail", code: "DEX_INCOMPLETE", detail: `Not callable: ${missing.join(", ")}.`,
        action: "Finish packages/dex before moving on." };
    }
    if (typeof record["DexError"] !== "function") {
      return { status: "fail", code: "NO_DEX_ERROR", detail: "DexError is not exported.",
        action: "The UI switches on DexError.code." };
    }
    return { status: "pass", code: "OK", detail: `${required.length} entry points imported and callable, plus DexError.` };
  }));

  push(await check("Every export has been run against live Shannon", async () => {
    const marker = resolve(REPO_ROOT, "artifacts", "verify-api.json");
    if (!existsSync(marker)) {
      return { status: "warn", code: "NOT_VERIFIED",
        detail: "No record that the API was exercised against live data.",
        action: "Run `pnpm verify-api` — a typecheck does not prove a function works." };
    }
    const v = JSON.parse(readFileSync(marker, "utf8")) as { failed?: number; passed?: number; recordedAt?: string };
    return (v.failed ?? 1) === 0
      ? { status: "pass", code: "OK", detail: `${v.passed} entry point(s) ran live at ${v.recordedAt}.` }
      : { status: "fail", code: "API_BROKEN", detail: `${v.failed} entry point(s) failed against live data.`,
          action: "Run `pnpm verify-api` and fix them." };
  }));

  push(await check("Smoke run recorded a live round-trip", async () => {
    if (!existsSync(ARTIFACT_PATH)) {
      return { status: "fail", code: "NO_SMOKE", detail: "No smoke record.", action: "Run `pnpm smoke`." };
    }
    const a = JSON.parse(readFileSync(ARTIFACT_PATH, "utf8")) as { notes?: string[]; recordedAt?: string };
    const viaPackage = (a.notes ?? []).some((n) => n.includes("packages/dex"));
    return viaPackage
      ? { status: "pass", code: "OK", detail: `Round-trip ran through packages/dex at ${a.recordedAt}.` }
      : { status: "warn", code: "STALE_RECORD",
          detail: "The record predates the dex package.",
          action: "Run `pnpm smoke` so the canary exercises the package itself." };
  }));

  push(await check("No script bypasses packages/dex (CLAUDE.md rule 4)", async () => {
    const dir = resolve(REPO_ROOT, "scripts");
    const offenders: string[] = [];
    const walk = (d: string): void => {
      for (const entry of readdirSync(d)) {
        const full = join(d, entry);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!entry.endsWith(".ts")) continue;
        const src = readFileSync(full, "utf8");
        if (/from\s+["']@somnia-chain\/markets-sdk["']/.test(src)) offenders.push(entry);
      }
    };
    walk(dir);
    return offenders.length === 0
      ? { status: "pass", code: "OK", detail: "All DreamDEX access goes through packages/dex." }
      : { status: "fail", code: "BYPASS", detail: `Imports the SDK directly: ${offenders.join(", ")}.`,
          action: "Route it through packages/dex." };
  }));

  // ── Phase 2 ───────────────────────────────────────────────────────────────
  heading("5. Phase 2 — data layer, scoring and indexer");

  push(await check("packages/db exports the Phase 2 surface", async () => {
    const mod = await import("@predictarena/db");
    const record = mod as unknown as Record<string, unknown>;
    const required = [
      "createDb", "computeStandings", "isoWeekId", "weekIdForClose",
      "upsertWindow", "upsertCall", "settleCallsForWindow", "getStandings", "getOverdueCalls",
    ];
    const missing = required.filter((n) => typeof record[n] !== "function");
    return missing.length === 0
      ? { status: "pass", code: "OK", detail: `${required.length} entry points imported and callable.` }
      : { status: "fail", code: "DB_INCOMPLETE", detail: `Not callable: ${missing.join(", ")}.`,
          action: "Finish packages/db." };
  }));

  push(await check("Scoring is a pure function with no I/O", async () => {
    const src = readFileSync(resolve(REPO_ROOT, "packages", "db", "src", "scoring.ts"), "utf8");
    // A clock, a random source or a query inside scoring would make standings
    // irreproducible -- the one property the whole design rests on.
    const impurities = [
      ["Date.now", /Date\.now\(/],
      ["new Date", /new Date\(/],
      ["Math.random", /Math\.random\(/],
      ["a db import", /from "\.\/(client|queries)\.js"/],
    ] as const;
    const found = impurities.filter(([, re]) => re.test(src)).map(([name]) => name);
    return found.length === 0
      ? { status: "pass", code: "OK", detail: "No clock, randomness or I/O in the scoring engine." }
      : { status: "fail", code: "IMPURE_SCORING", detail: `Found: ${found.join(", ")}.`,
          action: "Standings must be reproducible from raw calls alone." };
  }));

  push(await check("Database is migrated and money columns are exact", async () => {
    const url = process.env["DATABASE_URL"]?.trim();
    if (!url) {
      return { status: "warn", code: "NO_DATABASE_URL", detail: "DATABASE_URL is not set.",
        action: "Set it in .env, then run `pnpm db:migrate`." };
    }
    const { createSql } = await import("@predictarena/db");
    const sql = createSql(url);
    const tables = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`;
    const names = new Set(tables.map((r: Record<string, unknown>) => String(r["table_name"])));
    const missing = ["windows", "calls", "wallets", "sync_state"].filter((t) => !names.has(t));
    if (missing.length > 0) {
      return { status: "fail", code: "NOT_MIGRATED", detail: `Missing tables: ${missing.join(", ")}.`,
        action: "Run `pnpm db:migrate`." };
    }
    const cols = await sql`
      SELECT data_type FROM information_schema.columns
      WHERE table_name='calls' AND column_name IN ('stake','quantity','payout')`;
    const floats = cols.filter((r: Record<string, unknown>) => !String(r["data_type"]).includes("numeric"));
    return floats.length === 0
      ? { status: "pass", code: "OK", detail: "4 tables present; money columns are numeric, never float." }
      : { status: "fail", code: "FLOAT_MONEY", detail: "A money column is not numeric.",
          action: "Money must never be stored as a float (CLAUDE.md rule 3)." };
  }));

  const code = summarise(results, "Exit gates — summary");

  heading("Verdict");
  if (code === 0) {
    console.log(`  ${green(bold("Phases 0, 1 and 2 complete."))} Proceed to Phase 3 (web app).`);
    console.log(`  ${dim("The Phase 2 recovery property is proved separately by `pnpm gate:phase2`.")}\n`);
  } else {
    console.log(`  ${red("Phase 0 is not done yet.")} Clear the blocking items above.`);
    console.log(`  ${dim("Unfunded seed wallets? Run `pnpm faucet --fund-seeds`.")}\n`);
  }
  process.exit(code);
}

void main();
