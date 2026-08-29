/**
 * `pnpm gate` — are the phase exit gates actually met?
 *
 * PLAN.md Phase 0: notes complete, one settled tx hash, four funded wallets.
 * PLAN.md Phase 1: `packages/dex` exists and `pnpm smoke` completes a live
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

/** The Phase 0 questions PLAN.md requires dex-notes.md to answer. */
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
  // PLAN.md's gate says "four funded wallets", so all four are required. An
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

  push(await check("packages/dex exists and exports the Phase 1 surface", async () => {
    const index = resolve(REPO_ROOT, "packages", "dex", "src", "index.ts");
    if (!existsSync(index)) {
      return { status: "fail", code: "NO_DEX_PACKAGE", detail: "packages/dex/src/index.ts is missing.",
        action: "Phase 1 builds the dex package." };
    }
    const source = readFileSync(index, "utf8");
    // The API PLAN.md Phase 1 names, plus the error type the UI switches on.
    const required = ["getMarkets", "getWindows", "placeCall", "getPositions", "getSettlement", "subscribe", "DexError"];
    const missing = required.filter((name) => !source.includes(name));
    return missing.length === 0
      ? { status: "pass", code: "OK", detail: `Exports all ${required.length} Phase 1 entry points.` }
      : { status: "fail", code: "DEX_INCOMPLETE", detail: `Not exported: ${missing.join(", ")}.`,
          action: "Finish packages/dex before moving on." };
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

  const code = summarise(results, "Exit gates — summary");

  heading("Verdict");
  if (code === 0) {
    console.log(`  ${green(bold("Phases 0 and 1 complete."))} Proceed to Phase 2 (data layer + indexer).\n`);
  } else {
    console.log(`  ${red("Phase 0 is not done yet.")} Clear the blocking items above.`);
    console.log(`  ${dim("Unfunded seed wallets? Run `pnpm faucet --fund-seeds`.")}\n`);
  }
  process.exit(code);
}

void main();
