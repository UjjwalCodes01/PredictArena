/**
 * `pnpm doctor` \u2014 read-only health check for the whole stack.
 *
 * Answers in one pass, without signing anything: is the safety rail intact, is
 * the chain up, is the indexer up and caught up, do live windows exist for our
 * target series, and can the DEV wallet actually trade.
 *
 * Every check runs even when an earlier one fails \u2014 the point is to report all
 * the problems at once, not the first.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  assertLiveNetwork, getMarkets, getWindows, quoteCall, MarketStatus, headroomSecFor,
  formatFixed, formatStt, GAS_CEILING_WEI, TESTNET_ADDRESSES, explorerAddress,
  type DexClient, type Window, type Direction,
} from "@predictarena/dex";
import { createClientOrExit, getPrivateKey, loadEnv, REPO_ROOT, ENV_PATH, LINKS } from "./lib/env.js";
import {
  bold, dim, green, yellow, red, heading, report, info, check, summarise,
  describeError, type CheckResult,
} from "./lib/log.js";

const results: CheckResult[] = [];
const push = (r: CheckResult): CheckResult => (results.push(r), report(r), r);

/** Scans the tree for anything shaped like a committed private key. */
function scanForLeakedKeys(): string[] {
  const HEX64 = /\b0x[0-9a-fA-F]{64}\b/;
  const SKIP = new Set(["node_modules", ".git", "artifacts", "dist", ".next", ".pnpm-store", "coverage"]);
  const hits: string[] = [];
  const walk = (dir: string, depth = 0): void => {
    if (depth > 5) return;
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry) || entry === ".env") continue;
      const full = join(dir, entry);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full, depth + 1); continue; }
      if (st.size > 512_000) continue;
      if (!/\.(ts|tsx|js|mjs|json|md|ya?ml|sh)$/.test(entry) && entry !== ".env.example") continue;
      try {
        for (const line of readFileSync(full, "utf8").split("\n")) {
          if (HEX64.test(line) && /(_?(KEY|SECRET|PRIVATE))\s*[=:]/i.test(line)) {
            hits.push(`${full.replace(REPO_ROOT + "/", "")}: ${line.trim().slice(0, 60)}`);
          }
        }
      } catch { /* unreadable */ }
    }
  };
  walk(REPO_ROOT);
  return hits;
}

async function sectionSafety(): Promise<void> {
  heading("1. Safety rail");

  push(await check("Testnet-only guard (chain id + endpoint hosts)", async () => {
    loadEnv();
    return { status: "pass", code: "OK", detail: "Chain id and all endpoints are testnet." };
  }));

  push(await check(".gitignore excludes .env", async () => {
    const p = resolve(REPO_ROOT, ".gitignore");
    if (!existsSync(p)) {
      return { status: "fail", code: "NO_GITIGNORE", detail: "No .gitignore at the repo root.",
        action: "Create one with a bare `.env` line before any key exists." };
    }
    const rules = readFileSync(p, "utf8").split("\n").map((l) => l.trim());
    return rules.includes(".env")
      ? { status: "pass", code: "OK", detail: "`.env` is ignored (CLAUDE.md rule 2)." }
      : { status: "fail", code: "ENV_NOT_IGNORED", detail: "`.env` is not in .gitignore.",
          action: "Add a bare `.env` line now, then rotate every key in it." };
  }));

  push(await check("No private key in a non-ignored file", async () => {
    const hits = scanForLeakedKeys();
    return hits.length === 0
      ? { status: "pass", code: "OK", detail: "Scanned the tree; no key-shaped assignments outside .env." }
      : { status: "fail", code: "KEY_LEAK", detail: hits.slice(0, 3).join("  |  "),
          action: "STOP. Remove it, rotate the wallet, and never commit that file." };
  }));

  push(await check(".env file permissions", async () => {
    if (!existsSync(ENV_PATH)) {
      return { status: "skip", code: "NO_ENV", detail: "No .env yet \u2014 run `pnpm wallets`." };
    }
    const mode = statSync(ENV_PATH).mode & 0o777;
    return mode === 0o600
      ? { status: "pass", code: "OK", detail: "Mode 600 (owner-only)." }
      : { status: "warn", code: "LOOSE_PERMS", detail: `Mode ${mode.toString(8)} \u2014 readable beyond the owner.`,
          action: `Run: chmod 600 ${ENV_PATH}` };
  }));
}

async function sectionChain(client: DexClient): Promise<void> {
  heading("2. Chain \u2014 Somnia Shannon");

  push(await check("RPC is Shannon, collateral identity confirmed", async () => {
    const net = await assertLiveNetwork(client);
    return { status: "pass", code: "OK",
      detail: `chain ${net.chainId}, collateral ${net.collateralSymbol} (${net.collateralDecimals} dp)` };
  }));

  push(await check("Chain is producing blocks", async () => {
    const block = await client.rpc.getBlock();
    const ageSec = Math.round(Date.now() / 1000 - Number(block.timestamp));
    return ageSec > 120
      ? { status: "warn", code: "STALE_CHAIN", detail: `Head #${block.number} is ${ageSec}s old.`,
          action: "The testnet may be degraded. Check the hackathon Telegram." }
      : { status: "pass", code: "OK", detail: `Head #${block.number}, ${ageSec}s old.` };
  }));

  push(await check("Server clock offset", async () => {
    const offset = client.clock.offsetSeconds;
    return Math.abs(offset) > 30
      ? { status: "warn", code: "CLOCK_SKEW", detail: `This machine is ${offset}s off chain time.`,
          action: "Countdowns are corrected for this, but check the system clock." }
      : { status: "pass", code: "OK", detail: `${offset}s vs chain \u2014 countdowns are corrected regardless.` };
  }));

  push(await check("Protocol contracts deployed", async () => {
    const targets: Array<[string, string | undefined]> = [
      ["binaryModule", TESTNET_ADDRESSES.binaryModule],
      ["marketsCore", TESTNET_ADDRESSES.marketsCore],
      ["binarySettlement", TESTNET_ADDRESSES.binarySettlement],
      ["collateralRouter", TESTNET_ADDRESSES.collateralRouter],
      ["oracleHub", TESTNET_ADDRESSES.oracleHub],
    ];
    const missing: string[] = [];
    for (const [label, address] of targets) {
      if (!address) { missing.push(`${label} (no address)`); continue; }
      const code = await client.rpc.getCode({ address: address as `0x${string}` });
      if (!code || code === "0x") missing.push(label);
    }
    return missing.length === 0
      ? { status: "pass", code: "OK", detail: `${targets.length} core contracts have bytecode on Shannon.` }
      : { status: "fail", code: "MISSING_CONTRACT", detail: `No bytecode at: ${missing.join(", ")}.`,
          action: "The deployment moved. Re-check the SDK's exported addresses." };
  }));
}

async function sectionMarkets(client: DexClient): Promise<void> {
  heading("3. Markets and venues");

  push(await check("Indexer reachable, assets listed", async () => {
    const markets = await getMarkets(client, { force: true });
    for (const v of markets.venues) info(`venue ${v.venueId.slice(0, 18)}\u2026 (operator ${v.operatorId})`);
    return { status: "pass", code: "OK",
      detail: `assets: ${markets.assets.join(", ")} \u2014 ${markets.venues.length} venue(s), discovered at runtime` };
  }));

  push(await check("Indexer is caught up with the chain", async () => {
    const [sync, head] = await Promise.all([
      client.exchange.client.getSyncStatus(client.config.chainId),
      client.rpc.getBlockNumber(),
    ]);
    if (!sync || sync.latestProcessedBlock === null) {
      return { status: "warn", code: "NO_SYNC_STATUS", detail: "Indexer reported no sync status.",
        action: "Treat the chain as truth; gate actions on on-chain status." };
    }
    const lag = Math.max(0, Number(head) - sync.latestProcessedBlock);
    return lag > 500
      ? { status: "warn", code: "INDEXER_LAG", detail: `Indexer is ${lag} blocks behind head #${head}.`,
          action: "Gate every action on the on-chain status, never the indexer row." }
      : { status: "pass", code: "OK", detail: `Lag ~${lag} block(s) behind head #${head}.` };
  }));

  push(await check("Live series map (asset x interval)", async () => {
    const windows = await getWindows(client, { includeUntradable: true, limit: 200 });
    if (windows.length === 0) {
      return { status: "fail", code: "NO_MARKETS", detail: "No live binary markets at all.",
        action: "Windows respawn on a schedule; retry in a minute." };
    }
    const seen = new Map<string, number>();
    for (const w of windows) {
      const key = `${w.asset}|${w.intervalSec ?? "?"}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const rows = [...seen.entries()]
      .map(([k, n]) => { const [a = "?", iv = "0"] = k.split("|"); return { asset: a, iv: Number(iv), n }; })
      .sort((x, y) => x.asset.localeCompare(y.asset) || x.iv - y.iv);
    for (const r of rows) info(`${r.asset.padEnd(7)} ${String(r.iv).padStart(6)}s  x${r.n}`);
    const intervals = [...new Set(rows.map((r) => r.iv))].sort((a, b) => a - b);
    return { status: "pass", code: "OK",
      detail: `${windows.length} live windows across intervals: ${intervals.join(", ")}s.` };
  }));
}

async function sectionWindows(client: DexClient, asset: string, intervalSec: number, stake: bigint): Promise<void> {
  heading(`4. Windows \u2014 ${asset} @ ${intervalSec}s`);
  const d = client.collateral.decimals;

  let picked: Window | undefined;
  push(await check(`Tradable ${asset} windows on the ${intervalSec}s series`, async () => {
    const exact = await getWindows(client, { asset, intervalSec });
    if (exact.length > 0) {
      picked = exact[0];
      for (const w of exact.slice(0, 4)) {
        info(`${w.asset} closes in ${Math.round(w.secondsLeft)}s  strike=${w.strike}  Trading`);
      }
      return { status: "pass", code: "OK",
        detail: `${exact.length} window(s) open and accepting orders (on-chain status ${MarketStatus.Trading}).` };
    }
    const any = await getWindows(client, { asset });
    if (any.length === 0) {
      return { status: "fail", code: "NO_MARKETS", detail: `No tradable ${asset} windows right now.`,
        action: "Windows respawn on a schedule; retry in a minute." };
    }
    picked = any[0];
    const seen = [...new Set(any.map((w) => w.intervalSec ?? 0))].sort((a, b) => a - b).join(", ");
    return { status: "warn", code: "SERIES_UNAVAILABLE",
      detail: `No ${intervalSec}s window; other series are live (${seen}s).`,
      action: `Set TARGET_INTERVAL_SEC to one of those, or retry \u2014 the series may be mid-roll.` };
  }));

  if (!picked) return;
  const w = picked;

  push(await check("Selected window has expiry headroom", async () => {
    const need = headroomSecFor(w.intervalSec ?? 0);
    return w.secondsLeft >= need
      ? { status: "pass", code: "OK", detail: `${Math.round(w.secondsLeft)}s left, need >= ${need}s for this series.` }
      : { status: "warn", code: "WINDOW_CLOSING", detail: `Only ${Math.round(w.secondsLeft)}s left (need >= ${need}s).`,
          action: "Wait for the next window." };
  }));

  push(await check("A call would actually fill", async () => {
    const quotes: string[] = [];
    for (const dir of ["UP", "DOWN"] as Direction[]) {
      const q = await quoteCall(client, { window: w, direction: dir, stake }).catch(() => null);
      if (q) quotes.push(`${dir} @ ${formatFixed(q.limitPrice, d, 3)}`);
    }
    return quotes.length > 0
      ? { status: "pass", code: "OK", detail: `Fillable now: ${quotes.join("  |  ")} (cost per contract).` }
      : { status: "warn", code: "NO_LIQUIDITY", detail: "No resting asks on either side of this window.",
          action: "Makers quote intermittently. Run `pnpm survey` to find a fillable window." };
  }));
}

async function sectionWallet(client: DexClient, stake: bigint): Promise<void> {
  heading("5. DEV wallet readiness");
  const d = client.collateral.decimals;

  let key: `0x${string}` | undefined;
  try {
    key = getPrivateKey("DEV");
  } catch (e) {
    push({ name: "DEV key readable", status: "fail", code: "BAD_PRIVATE_KEY",
      detail: describeError(e), action: "Re-run `pnpm wallets --force` or fix .env by hand." });
    return;
  }
  if (!key) {
    push({ name: "DEV wallet configured", status: "fail", code: "NO_WALLET",
      detail: "DEV_PRIVATE_KEY is empty.", action: "Run `pnpm wallets`, then fund the printed address." });
    return;
  }

  const account = privateKeyToAccount(key);
  push({ name: "DEV wallet configured", status: "pass", code: "OK", detail: account.address });
  info(explorerAddress(account.address));

  push(await check("STT balance (gas)", async () => {
    const wei = await client.rpc.getBalance({ address: account.address });
    if (wei === 0n) {
      return { status: "fail", code: "INSUFFICIENT_GAS", detail: "0 STT \u2014 cannot send any transaction.",
        action: `Get STT from the faucet: ${LINKS.faucet}` };
    }
    if (wei < GAS_CEILING_WEI) {
      return { status: "warn", code: "LOW_GAS",
        detail: `${formatStt(wei)} STT \u2014 below the ~0.6 the SDK's fixed gas ceiling requires.`,
        action: `Top up at ${LINKS.faucet}, or a write may be refused by the mempool.` };
    }
    return { status: "pass", code: "OK", detail: `${formatStt(wei)} STT` };
  }));

  push(await check(`${client.collateral.symbol} balance (stake)`, async () => {
    const bal = await client.rpc.readContract({
      address: client.collateral.address, abi: erc20Abi, functionName: "balanceOf", args: [account.address],
    });
    if (bal === 0n) {
      return { status: "fail", code: "INSUFFICIENT_STAKE",
        detail: `0 ${client.collateral.symbol} \u2014 nothing to stake.`,
        action: "Run `pnpm faucet` \u2014 the collateral contract mints its own." };
    }
    if (bal < stake) {
      return { status: "warn", code: "LOW_STAKE",
        detail: `${formatFixed(bal, d, 2)} ${client.collateral.symbol}, below the configured stake.`,
        action: "Run `pnpm faucet`, or lower STAKE_TUSDC in .env." };
    }
    return { status: "pass", code: "OK", detail: `${formatFixed(bal, d, 2)} ${client.collateral.symbol}` };
  }));

  push(await check("Unclaimed winnings", async () => {
    try {
      const claimable = await client.exchange.client.getClaimable(account.address);
      if (claimable.length === 0) return { status: "pass", code: "OK", detail: "Nothing outstanding." };
      for (const c of claimable.slice(0, 5)) {
        info(`${c.marketId.slice(0, 12)}\u2026 outcome ${c.outcomeIdx} ~${formatFixed(c.estPayout, d, 2)}`);
      }
      return { status: "warn", code: "UNCLAIMED",
        detail: `${claimable.length} settled position(s) not yet redeemed.`,
        action: "Winnings are claimed, not received \u2014 run `pnpm claim`." };
    } catch (e) {
      return { status: "warn", code: "API_DOWN", detail: `Indexer claim lookup failed: ${describeError(e)}`,
        action: "Chain reads still work; `pnpm claim --market <id>` redeems a known position." };
    }
  }));
}

async function main(): Promise<void> {
  console.log(bold("\nPrediction Leagues \u2014 doctor"));
  console.log(dim("Read-only. Nothing here signs a transaction.\n"));

  await sectionSafety();

  const { client, env } = createClientOrExit();
  const stake = BigInt(Math.round(env.stakeWhole)) * 10n ** BigInt(client.collateral.decimals);

  try {
    await sectionChain(client);
    await sectionMarkets(client);
    await sectionWindows(client, env.targetAsset, env.targetIntervalSec, stake);
    await sectionWallet(client, stake);

    const code = summarise(results, "Doctor \u2014 summary");

    heading("Next step");
    if (code === 0) {
      console.log(`  ${green("Stack is healthy and the DEV wallet is funded.")}`);
      console.log(`  Run the full live round-trip:  ${bold("pnpm smoke")}\n`);
    } else if (results.some((r) => r.code === "INSUFFICIENT_GAS" || r.code === "NO_WALLET")) {
      console.log(`  ${yellow("The stack is fine; the wallet needs funding.")}`);
      console.log(`  1. ${bold("pnpm wallets")}  2. Fund STT at ${bold(LINKS.faucet)}  3. ${bold("pnpm faucet")}\n`);
    } else if (results.some((r) => r.code === "INSUFFICIENT_STAKE")) {
      console.log(`  ${yellow("Mint collateral:")} ${bold("pnpm faucet")}\n`);
    } else {
      console.log(`  ${red("Resolve the blocking issues above, then re-run.")}\n`);
    }
    client.close();
    process.exit(code);
  } catch (e) {
    console.log(`\n${red("\u2718 Doctor aborted:")} ${describeError(e)}`);
    client.close();
    process.exit(1);
  }
}

void main();
