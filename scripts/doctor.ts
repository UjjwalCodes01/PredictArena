/**
 * `pnpm doctor` — read-only Phase 0 sanity check.
 *
 * Answers, in one pass and without signing anything: is the safety rail intact,
 * is the chain up, is the indexer up and caught up, do live Up/Down windows
 * exist for our target series, and is the DEV wallet ready to place an order.
 *
 * Runs every check even when an early one fails — the point is to report all
 * the problems at once, not the first one. Exit code 0 only when nothing is
 * blocking.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  loadConfig, getPrivateKey, ENV_PATH, REPO_ROOT, LINKS, explorerAddr, ConfigError,
} from "./lib/config.js";
import {
  createDex, assertLiveTestnet, findTradableWindows, headroomSecFor, STATUS_TRADING, DexError, type Dex,
} from "./lib/dex.js";
import { formatFixed, formatStt, priceToPercent } from "./lib/money.js";
import { bold, dim, green, yellow, red, heading, report, kv, info, check, summarise, describeError, type CheckResult } from "./lib/log.js";

const results: CheckResult[] = [];
const push = (r: CheckResult): CheckResult => (results.push(r), report(r), r);

/** Scans tracked-ish files for anything shaped like a private key. */
function scanForLeakedKeys(): string[] {
  const HEX64 = /\b0x[0-9a-fA-F]{64}\b/;
  const SKIP = new Set(["node_modules", ".git", "artifacts", "dist", ".next", ".pnpm-store"]);
  const hits: string[] = [];
  const walk = (dir: string, depth = 0): void => {
    if (depth > 4) return;
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry) || entry === ".env") continue;
      const full = join(dir, entry);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full, depth + 1); continue; }
      if (st.size > 512_000) continue;
      if (!/\.(ts|tsx|js|mjs|json|md|ya?ml|env\.example|sh)$/.test(entry) && entry !== ".env.example") continue;
      try {
        const text = readFileSync(full, "utf8");
        for (const line of text.split("\n")) {
          // Addresses are 40 hex chars; only 64 is key-shaped. Ignore tx hashes
          // in docs, which are the same shape — flag only assignment-looking lines.
          if (HEX64.test(line) && /(_?(KEY|SECRET|PRIVATE))\s*[=:]/i.test(line)) {
            hits.push(`${full.replace(REPO_ROOT + "/", "")}: ${line.trim().slice(0, 60)}…`);
          }
        }
      } catch { /* unreadable, skip */ }
    }
  };
  walk(REPO_ROOT);
  return hits;
}

async function sectionSafety(): Promise<void> {
  heading("1. Safety rail");

  push(await check("Testnet-only guard (chain id + endpoint hosts)", async () => {
    loadConfig(); // throws on mainnet chain id, mainnet hosts, mainnet collateral
    return { status: "pass", detail: "CHAIN_ID and all *_URL values are testnet.", code: "OK" };
  }));

  push(await check(".gitignore excludes .env", async () => {
    const p = resolve(REPO_ROOT, ".gitignore");
    if (!existsSync(p)) {
      return { status: "fail", code: "NO_GITIGNORE", detail: "No .gitignore at the repo root.",
        action: "Create one with a bare `.env` line before any key exists." };
    }
    const rules = readFileSync(p, "utf8").split("\n").map((l) => l.trim());
    return rules.includes(".env")
      ? { status: "pass", detail: "`.env` is ignored (CLAUDE.md rule 2).", code: "OK" }
      : { status: "fail", code: "ENV_NOT_IGNORED", detail: "`.env` is not in .gitignore.",
          action: "Add a bare `.env` line immediately, then rotate every key in it." };
  }));

  push(await check("No private key in a non-ignored file", async () => {
    const hits = scanForLeakedKeys();
    return hits.length === 0
      ? { status: "pass", detail: "Scanned the tree; no key-shaped assignments outside .env.", code: "OK" }
      : { status: "fail", code: "KEY_LEAK", detail: hits.slice(0, 3).join("  |  "),
          action: "STOP. Remove the key, rotate the wallet, and never commit that file." };
  }));

  push(await check(".env file permissions", async () => {
    if (!existsSync(ENV_PATH)) {
      return { status: "skip", detail: "No .env yet — run `pnpm wallets`.", code: "NO_ENV" };
    }
    const mode = statSync(ENV_PATH).mode & 0o777;
    return mode === 0o600
      ? { status: "pass", detail: "Mode 600 (owner-only).", code: "OK" }
      : { status: "warn", code: "LOOSE_PERMS", detail: `Mode ${mode.toString(8)} — readable beyond the owner.`,
          action: `Run: chmod 600 ${ENV_PATH}` };
  }));
}

async function sectionChain(dex: Dex): Promise<void> {
  heading("2. Chain — Somnia Shannon");

  push(await check("RPC reachable and is Shannon (50312)", async () => {
    const { chainId, collateralSymbol, collateralDecimals } = await assertLiveTestnet(dex);
    return { status: "pass", code: "OK",
      detail: `chainId=${chainId}  collateral=${collateralSymbol} (${collateralDecimals} dp)  rpc=${dex.cfg.rpcHttpUrl}` };
  }));

  push(await check("Chain is producing blocks", async () => {
    const block = await dex.rpc.getBlock();
    const ageSec = Math.round(Date.now() / 1000 - Number(block.timestamp));
    if (ageSec > 120) {
      return { status: "warn", code: "STALE_CHAIN", detail: `Head block #${block.number} is ${ageSec}s old.`,
        action: "The testnet may be degraded. Check the hackathon Telegram." };
    }
    return { status: "pass", detail: `Head block #${block.number}, ${ageSec}s old.`, code: "OK" };
  }));

  push(await check("Collateral token identity (tUSDC, 6 dp)", async () => {
    const addr = dex.cfg.collateral.address;
    if (!addr) return { status: "fail", code: "NO_COLLATERAL", detail: "SDK exposed no collateral address.", action: "Upgrade @somnia-chain/markets-sdk." };
    const [symbol, decimals, name] = await Promise.all([
      dex.rpc.readContract({ address: addr, abi: erc20Abi, functionName: "symbol" }),
      dex.rpc.readContract({ address: addr, abi: erc20Abi, functionName: "decimals" }),
      dex.rpc.readContract({ address: addr, abi: erc20Abi, functionName: "name" }),
    ]);
    const ok = symbol === "tUSDC" && decimals === 6;
    return ok
      ? { status: "pass", code: "OK", detail: `${name} (${symbol}), ${decimals} dp, ${addr}` }
      : { status: "fail", code: "COLLATERAL_CHANGED",
          detail: `Expected tUSDC/6, chain says ${symbol}/${decimals} at ${addr}.`,
          action: "Every money path assumes 6 decimals. Stop and update docs/dex-notes.md §2." };
  }));

  push(await check("Protocol contracts deployed", async () => {
    const a = dex.cfg.addresses;
    const targets: Array<[string, string | undefined]> = [
      ["binaryModule", a.binaryModule], ["marketsCore", a.marketsCore],
      ["binarySettlement", a.binarySettlement], ["collateralRouter", a.collateralRouter],
      ["oracleHub", a.oracleHub],
    ];
    const missing: string[] = [];
    for (const [label, address] of targets) {
      if (!address) { missing.push(`${label} (no address)`); continue; }
      const code = await dex.rpc.getCode({ address: address as `0x${string}` });
      if (!code || code === "0x") missing.push(label);
    }
    return missing.length === 0
      ? { status: "pass", code: "OK", detail: `${targets.length} core contracts have bytecode on Shannon.` }
      : { status: "fail", code: "MISSING_CONTRACT", detail: `No bytecode at: ${missing.join(", ")}.`,
          action: "The deployment moved. Re-read the SDK's exported addresses." };
  }));
}

async function sectionIndexer(dex: Dex): Promise<void> {
  heading("3. Indexer — Event Contract market data");

  push(await check("Indexer reachable", async () => {
    const assets = await dex.exchange.client.listBinaryAssets();
    if (assets.length === 0) {
      return { status: "fail", code: "NO_MARKETS", detail: "Indexer answered but lists no binary assets.",
        action: `Confirm INDEXER_URL is the Shannon indexer: ${dex.cfg.indexerUrl}` };
    }
    return { status: "pass", code: "OK", detail: `${dex.cfg.indexerUrl} — assets: ${assets.join(", ")}` };
  }));

  push(await check("Indexer is caught up with the chain", async () => {
    const [status, head] = await Promise.all([
      dex.exchange.client.getSyncStatus(dex.cfg.chainId),
      dex.rpc.getBlockNumber(),
    ]);
    if (!status || status.latestProcessedBlock === null) {
      return { status: "warn", code: "NO_SYNC_STATUS", detail: "Indexer reported no sync status.",
        action: "Treat the chain as truth; poll rather than trusting indexer rows." };
    }
    // Can read slightly negative: the head advances between the two reads.
    const lag = Math.max(0, Number(head) - status.latestProcessedBlock);
    if (lag > 500) {
      return { status: "warn", code: "INDEXER_LAG", detail: `Indexer is ${lag} blocks behind head #${head}.`,
        action: "Gate every action on the on-chain status, never the indexer row." };
    }
    return { status: "pass", code: "OK", detail: `Lag ~${lag} block(s) behind head #${head}.` };
  }));

  push(await check("Venue discovery", async () => {
    const venues = await dex.exchange.client.listBinaryVenueIds();
    if (venues.length === 0) {
      return { status: "fail", code: "NO_VENUE", detail: "No binary venues found.",
        action: "Ask in the hackathon Telegram — see docs/questions-for-telegram.md Q3." };
    }
    for (const v of venues) info(`venue ${v.venueId.slice(0, 18)}…  (operator ${v.operatorId})`);
    return { status: "pass", code: "OK",
      detail: `${venues.length} live venue(s). Discovered at runtime — venue ids move, never pin one.` };
  }));

  // Which series actually exist right now, and on which venue. One deployment
  // hosts several venues and their markets sit side by side in the indexer, so
  // "is the 300s series live" is a per-venue question, not a global one.
  push(await check("Live series map (asset x interval x venue)", async () => {
    const live = await dex.exchange.client.listLiveBinaryMarkets({ orderBy: "closingSoon", limit: 200 });
    if (live.length === 0) {
      return { status: "fail", code: "NO_MARKETS", detail: "No live binary markets at all.",
        action: "Windows respawn on a schedule; retry in a minute." };
    }
    const seen = new Map<string, number>();
    for (const m of live) {
      const key = `${m.asset}|${m.intervalSec ?? "?"}|${m.venueId ?? "?"}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const rows = [...seen.entries()]
      .map(([k, n]) => { const [asset, iv, venue] = k.split("|"); return { asset: asset ?? "?", iv: Number(iv), venue: venue ?? "?", n }; })
      .sort((a, b) => a.asset.localeCompare(b.asset) || a.iv - b.iv);
    for (const r of rows) {
      info(`${r.asset.padEnd(4)} ${String(r.iv).padStart(6)}s  x${String(r.n).padStart(2)}  venue ${r.venue.slice(0, 14)}…`);
    }
    const intervals = [...new Set(rows.map((r) => r.iv))].sort((a, b) => a - b);
    return { status: "pass", code: "OK",
      detail: `${live.length} live windows across intervals: ${intervals.join(", ")}s.` };
  }));
}

async function sectionMarkets(dex: Dex): Promise<{ picked: Awaited<ReturnType<typeof findTradableWindows>>[number] | undefined }> {
  heading(`4. Windows — ${dex.cfg.targetAsset} @ ${dex.cfg.targetIntervalSec}s`);

  let picked: Awaited<ReturnType<typeof findTradableWindows>>[number] | undefined;

  push(await check(`Tradable ${dex.cfg.targetAsset} windows on the ${dex.cfg.targetIntervalSec}s series`, async () => {
    const exact = await findTradableWindows(dex, {
      asset: dex.cfg.targetAsset, intervalSec: dex.cfg.targetIntervalSec,
    });
    if (exact.length > 0) {
      picked = exact[0];
      for (const w of exact.slice(0, 4)) {
        info(`${w.market.asset}  closes in ${Math.round(w.secondsLeft)}s  strike=${w.market.strike}  status=Trading`);
      }
      return { status: "pass", code: "OK",
        detail: `${exact.length} window(s) open and accepting orders (on-chain status ${STATUS_TRADING}).` };
    }
    const any = await findTradableWindows(dex, { asset: dex.cfg.targetAsset });
    if (any.length === 0) {
      return { status: "fail", code: "NO_MARKETS",
        detail: `No tradable ${dex.cfg.targetAsset} windows at all right now.`,
        action: "Windows respawn on a schedule; retry in a minute. If it persists, ask in Telegram." };
    }
    picked = any[0];
    const seen = [...new Set(any.map((w) => w.market.intervalSec ?? "?"))].join(", ");
    return { status: "warn", code: "SERIES_UNAVAILABLE",
      detail: `No ${dex.cfg.targetIntervalSec}s window; other series are live (intervalSec: ${seen}).`,
      action: `Set TARGET_INTERVAL_SEC to one of those, or retry — the ${dex.cfg.targetIntervalSec}s series may be mid-roll.` };
  }));

  if (!picked) return { picked };
  const w = picked;

  push(await check("Selected window has expiry headroom", async () => {
    const interval = Number(w.market.intervalSec ?? dex.cfg.targetIntervalSec);
    const need = headroomSecFor(interval);
    return w.secondsLeft >= need
      ? { status: "pass", code: "OK", detail: `${Math.round(w.secondsLeft)}s left, need ≥${need}s for a ${interval}s series.` }
      : { status: "warn", code: "WINDOW_CLOSING", detail: `Only ${Math.round(w.secondsLeft)}s left (need ≥${need}s).`,
          action: "Wait for the next window — this one may lock between snapshot and send." };
  }));

  push(await check("Book parameters readable (tick / lot / min)", async () => {
    const p = await dex.exchange.client.getBinaryBookParams(w.onchain.pool);
    kv("tickSize", p.tickSize.toString());
    kv("lotSize", p.lotSize.toString());
    kv("minQuantity", p.minQuantity.toString());
    return { status: "pass", code: "OK",
      detail: "Read from chain — the indexer returns null for these; quantize against them yourself." };
  }));

  push(await check("Order book has liquidity", async () => {
    const book = await dex.exchange.client.getBinaryOrderBook(w.onchain.pool, { depth: 5 });
    const d = dex.cfg.collateral.decimals;
    const top = (levels: { price: bigint; quantity: bigint }[] | undefined): string =>
      levels?.[0] ? priceToPercent(levels[0].price, d) : "—";

    // Up and Down share one book quoted in Up terms; to BUY Up you lift yesAsks,
    // to BUY Down you lift noAsks (docs/dex-notes.md §3).
    kv("Up   bid / ask", `${top(book.yesBids)} / ${top(book.yesAsks)}`);
    kv("Down bid / ask", `${top(book.noBids)} / ${top(book.noAsks)}`);

    const canBuyUp = (book.yesAsks?.length ?? 0) > 0;
    const canBuyDown = (book.noAsks?.length ?? 0) > 0;
    if (!canBuyUp && !canBuyDown) {
      return { status: "warn", code: "NO_LIQUIDITY", detail: "No resting asks on either outcome.",
        action: "A taker order cannot fill. Rest a limit order, or pick a window that has quotes." };
    }
    const sides = [canBuyUp ? "Up" : null, canBuyDown ? "Down" : null].filter(Boolean).join(" and ");
    return { status: "pass", code: "OK", detail: `Takeable now on: ${sides}. Prices shown are Up probabilities.` };
  }));

  return { picked };
}

async function sectionWallet(dex: Dex): Promise<void> {
  heading("5. DEV wallet readiness");

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
      detail: "DEV_PRIVATE_KEY is empty.", action: "Run `pnpm wallets`, then fund the printed DEV address." });
    return;
  }

  const account = privateKeyToAccount(key);
  push({ name: "DEV wallet configured", status: "pass", code: "OK", detail: `${account.address}` });
  info(explorerAddr(account.address));

  const gas = await check("STT balance (gas)", async () => {
    const wei = await dex.rpc.getBalance({ address: account.address });
    // The SDK sends every write with a fixed 10M gas ceiling at 60 gwei — the
    // mempool only admits a tx whose ceiling is funded, so ~0.6 STT must be
    // present even though the unused remainder is refunded.
    const needed = 600_000_000_000_000_000n;
    if (wei === 0n) {
      return { status: "fail" as const, code: "INSUFFICIENT_GAS", detail: "0 STT — cannot send any transaction.",
        action: `Get STT from the faucet: ${LINKS.faucet}` };
    }
    if (wei < needed) {
      return { status: "warn" as const, code: "LOW_GAS",
        detail: `${formatStt(wei)} STT — below the ~0.6 STT the SDK's 10M gas ceiling requires.`,
        action: `Top up at ${LINKS.faucet} or a write may be refused by the mempool.` };
    }
    return { status: "pass" as const, code: "OK", detail: `${formatStt(wei)} STT` };
  });
  push(gas);

  const collateral = dex.cfg.collateral.address;
  push(await check("tUSDC balance (stake)", async () => {
    if (!collateral) return { status: "fail", code: "NO_COLLATERAL", detail: "No collateral address." };
    const bal = await dex.rpc.readContract({
      address: collateral, abi: erc20Abi, functionName: "balanceOf", args: [account.address],
    });
    const d = dex.cfg.collateral.decimals;
    if (bal === 0n) {
      return { status: "fail", code: "INSUFFICIENT_STAKE",
        detail: `0 tUSDC — nothing to stake. Note this is tUSDC (${d} dp), NOT USDso.`,
        action: `Mint/request tUSDC at ${LINKS.faucet} for ${account.address}` };
    }
    const want = BigInt(dex.cfg.stakeTusdc) * 10n ** BigInt(d);
    if (bal < want) {
      return { status: "warn", code: "LOW_STAKE",
        detail: `${formatFixed(bal, d, 2)} tUSDC, below STAKE_TUSDC=${dex.cfg.stakeTusdc}.`,
        action: `Top up at ${LINKS.faucet}, or lower STAKE_TUSDC in .env.` };
    }
    return { status: "pass", code: "OK", detail: `${formatFixed(bal, d, 2)} tUSDC` };
  }));

  push(await check("Unclaimed winnings", async () => {
    const claimable = await dex.exchange.client.getClaimable(account.address);
    if (claimable.length === 0) {
      return { status: "pass", code: "OK", detail: "Nothing outstanding." };
    }
    const d = dex.cfg.collateral.decimals;
    for (const c of claimable.slice(0, 5)) {
      info(`${c.marketId.slice(0, 12)}…  outcome ${c.outcomeIdx}  ≈${formatFixed(c.estPayout, d, 2)} tUSDC  (${c.status})`);
    }
    return { status: "warn", code: "UNCLAIMED",
      detail: `${claimable.length} settled position(s) not yet redeemed.`,
      action: "Winnings are claimed, not received — run `pnpm place-one --claim-only` to sweep them." };
  }));
}

async function main(): Promise<void> {
  console.log(bold("\nPrediction Leagues — Phase 0 doctor"));
  console.log(dim("Read-only. Nothing here signs a transaction.\n"));

  await sectionSafety();

  let dex: Dex;
  try {
    dex = createDex();
  } catch (e) {
    const isConfig = e instanceof ConfigError || e instanceof DexError;
    console.log(`\n${red("✘ Could not build the DreamDEX client.")}`);
    console.log(`  ${describeError(e)}`);
    if (isConfig) console.log(`  ${yellow("→")} Fix .env and re-run.`);
    process.exit(1);
  }

  try {
    await sectionChain(dex);
    await sectionIndexer(dex);
    const { picked } = await sectionMarkets(dex);
    await sectionWallet(dex);

    const code = summarise(results, "Phase 0 doctor — summary");

    heading("Next step");
    if (code === 0 && picked) {
      console.log(`  ${green("Stack is healthy and the DEV wallet is funded.")}`);
      console.log(`  Place the single Phase 0 probe order:  ${bold("pnpm place-one")}\n`);
    } else if (results.some((r) => r.code === "INSUFFICIENT_GAS" || r.code === "INSUFFICIENT_STAKE" || r.code === "NO_WALLET")) {
      console.log(`  ${yellow("The stack is fine; the wallet just needs funding.")}`);
      console.log(`  1. ${bold("pnpm wallets")}  ${dim("(if you have not yet)")}`);
      console.log(`  2. Fund the DEV address at ${bold(LINKS.faucet)} with STT ${dim("and")} tUSDC`);
      console.log(`  3. ${bold("pnpm doctor")} again, then ${bold("pnpm place-one")}\n`);
    } else {
      console.log(`  ${red("Resolve the blocking issues above, then re-run `pnpm doctor`.")}\n`);
    }
    dex.close();
    process.exit(code);
  } catch (e) {
    console.log(`\n${red("✘ Doctor aborted:")} ${describeError(e)}`);
    dex.close();
    process.exit(1);
  }
}

void main();
