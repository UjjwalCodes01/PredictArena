/**
 * `pnpm place-one` — PLACE ONE REAL EVENT CONTRACT ORDER AND WATCH IT SETTLE.
 *
 * This is the Phase 0 exit gate. It is the only Phase 0 script that signs.
 *
 * Flow: preflight → quote → place (taker) → verify receipt → await settlement
 * → redeem → write artifacts/phase0-probe.json.
 *
 * Flags:
 *   --dry-run          quote and preflight, sign nothing
 *   --claim-only       skip placing; just sweep unredeemed winnings
 *   --side up|down     which way to call (default: up)
 *   --asset BTC|ETH    override TARGET_ASSET
 *   --interval <sec>   override TARGET_INTERVAL_SEC
 *   --yes              skip the confirmation prompt
 *
 * Two behaviours here exist because of measured SDK edges, not caution:
 *   - A reverted write does NOT throw; the receipt rides on the result and must
 *     be inspected, or a failed order is recorded as pending forever.
 *   - Winnings are claimed, not received: settlement alone moves no funds.
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi, keccak256, encodePacked } from "viem";
import type { BinaryMarket, MarketOnchain } from "@somnia-chain/markets-sdk";
import { ORDER_TYPE } from "@somnia-chain/markets-sdk";
import { getPrivateKey, REPO_ROOT, LINKS, explorerTx } from "./lib/config.js";
import {
  createDexOrExit, assertLiveTestnet, findTradableWindows, awaitSettlement, headroomSecFor,
  quoteStakeOnChain, STATUS_TRADING, DexError, sleep, type Dex,
} from "./lib/dex.js";
import { formatFixed, formatStt, priceToPercent } from "./lib/money.js";
import { bold, dim, green, yellow, red, blue, heading, kv, info, describeError } from "./lib/log.js";

const ARGS = process.argv.slice(2);
const has = (f: string): boolean => ARGS.includes(f);
const val = (f: string): string | undefined => {
  const i = ARGS.indexOf(f);
  return i >= 0 ? ARGS[i + 1] : undefined;
};

const DRY_RUN = has("--dry-run");
const CLAIM_ONLY = has("--claim-only");
const ASSUME_YES = has("--yes");
const SIDE_EXPLICIT = val("--side") !== undefined;
const SIDE_ARG = (val("--side") ?? "up").toLowerCase();
if (SIDE_ARG !== "up" && SIDE_ARG !== "down") {
  console.error(red(`--side must be "up" or "down", got "${SIDE_ARG}".`));
  process.exit(2);
}
type BuySide = "BUY_YES" | "BUY_NO";
const sideOf = (s: string): BuySide => (s === "up" ? "BUY_YES" : "BUY_NO");
const labelOf = (s: BuySide): string => (s === "BUY_YES" ? "UP" : "DOWN");
/** Longest window we will sit through for a Phase 0 probe. */
const MAX_PROBE_WAIT_SEC = 20 * 60;

const ARTIFACT_DIR = resolve(REPO_ROOT, "artifacts");
const ARTIFACT_PATH = resolve(ARTIFACT_DIR, "phase0-probe.json");

interface Artifact {
  recordedAt: string;
  chainId: number;
  wallet: string;
  asset: string;
  intervalSec: number | null;
  marketId: string;
  pool: string;
  venueId: string | null;
  question: string;
  strike: string;
  expiry: string;
  side: "BUY_YES" | "BUY_NO";
  stakeTusdc: string;
  limitPrice: string;
  quantity: string;
  escrow: string;
  orderTxHash: string;
  orderStatus: "filled" | "partial" | "unfilled";
  fills: Array<{ quantity: string; price: string }>;
  settlement: { status: "RESOLVED" | "VOIDED"; winningOutcome: number | null } | null;
  outcome: "WON" | "LOST" | "VOID" | null;
  redeemTxHash: string | null;
  payoutTusdc: string | null;
  notes: string[];
}

async function confirm(question: string): Promise<boolean> {
  if (ASSUME_YES) return true;
  if (!process.stdin.isTTY) {
    console.log(dim("  (non-interactive shell — pass --yes to proceed without a prompt)"));
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${yellow("?")} ${question} ${dim("[y/N]")} `)).trim().toLowerCase();
  rl.close();
  return answer === "y" || answer === "yes";
}

/**
 * Idempotency key carried on the order itself. AGENTS.md asks for a client
 * order id per (wallet, market, window); `PlaceOrderParams.userData` is that
 * field. Deterministic, so an accidental re-run is identifiable on-chain.
 */
function idempotencyKey(wallet: `0x${string}`, marketId: `0x${string}`): bigint {
  const digest = keccak256(encodePacked(["address", "bytes32"], [wallet, marketId]));
  return BigInt(digest) & ((1n << 64n) - 1n);
}

/**
 * Redeems ONE known position using chain reads only.
 *
 * `getClaimable()` goes through the indexer's Portfolio query, which failed
 * mid-probe with "indexer Portfolio failed: fetch failed" — leaving a won
 * position unredeemed. Winnings must never be stranded by an indexer blip, and
 * after a settlement we already know the marketId and the outcome we hold, so
 * the indexer is not needed at all for this path.
 */
async function redeemKnownPosition(
  dex: Dex,
  wallet: `0x${string}`,
  trader: ReturnType<Dex["exchange"]["client"]["createTrader"]>,
  marketId: `0x${string}`,
  outcomeIdx: 0 | 1,
): Promise<{ hash: string; amount: bigint } | null> {
  const d = dex.cfg.collateral.decimals;
  const oc = await dex.exchange.client.getMarketOnchain(marketId);
  const id = outcomeIdx === 0 ? oc.yesId : oc.noId;
  const held = await dex.exchange.client.getOutcomeBalance({
    outcomeToken: oc.outcomeToken, account: wallet, id,
  });
  if (held <= 0n) {
    info(`No outcome-${outcomeIdx} tokens held — nothing to redeem.`);
    return null;
  }
  info(`Holding ${formatFixed(held, d, 4)} outcome-${outcomeIdx} token(s); redeeming.`);
  if (DRY_RUN) { info(dim("  (dry run — not sent)")); return null; }

  const res = await trader.redeem({ marketId, amount: held, outcomeIdx, market: oc.marketAddress, outcomeToken: oc.outcomeToken });
  if (res.receipt.status === "reverted") {
    console.log(`  ${red("redeem reverted")} ${explorerTx(res.hash)}`);
    return null;
  }
  console.log(`  ${green("✔")} ${explorerTx(res.hash)}`);
  return { hash: res.hash, amount: held };
}

/** Sweeps every redeemable position. Winnings do not arrive on their own. */
async function claimAll(dex: Dex, wallet: `0x${string}`, trader: ReturnType<Dex["exchange"]["client"]["createTrader"]>): Promise<{ claimed: number; txs: string[]; total: bigint }> {
  const d = dex.cfg.collateral.decimals;
  // The Portfolio query is an indexer read and does fail transiently; one retry
  // covers a blip, and callers that know their position use the chain path above.
  let claimable: Awaited<ReturnType<typeof dex.exchange.client.getClaimable>>;
  try {
    claimable = await dex.exchange.client.getClaimable(wallet);
  } catch (e) {
    info(dim(`indexer claim lookup failed (${describeError(e)}) — retrying once`));
    await sleep(4_000);
    try {
      claimable = await dex.exchange.client.getClaimable(wallet);
    } catch (e2) {
      console.log(`  ${yellow("!")} Could not list claimable positions: ${describeError(e2)}`);
      console.log(`    ${yellow("→")} Re-run \`pnpm place-one --claim-only\` once the indexer recovers.`);
      return { claimed: 0, txs: [], total: 0n };
    }
  }
  if (claimable.length === 0) {
    info("Nothing to claim.");
    return { claimed: 0, txs: [], total: 0n };
  }
  const txs: string[] = [];
  let total = 0n;
  for (const c of claimable) {
    if (c.amount <= 0n) continue;
    info(`redeeming ${c.marketId.slice(0, 14)}… outcome ${c.outcomeIdx} ≈${formatFixed(c.estPayout, d, 2)} tUSDC`);
    if (DRY_RUN) { info(dim("  (dry run — not sent)")); continue; }
    try {
      // Serialised deliberately: claiming signs from the same key as trading and
      // two senders on one key race each other's nonce.
      const res = await trader.redeem({ marketId: c.marketId as `0x${string}`, amount: c.amount, outcomeIdx: c.outcomeIdx });
      if (res.receipt.status === "reverted") {
        console.log(`  ${red("redeem reverted")} ${explorerTx(res.hash)}`);
        continue;
      }
      txs.push(res.hash);
      total += c.estPayout;
      console.log(`  ${green("✔")} ${explorerTx(res.hash)}`);
    } catch (e) {
      console.log(`  ${red("redeem failed:")} ${describeError(e)}`);
    }
  }
  return { claimed: txs.length, txs, total };
}

async function main(): Promise<void> {
  console.log(bold("\nPrediction Leagues — Phase 0 probe order"));
  console.log(dim(DRY_RUN ? "DRY RUN — nothing will be signed.\n" : "This signs and sends REAL testnet transactions.\n"));

  let key: `0x${string}` | undefined;
  try {
    key = getPrivateKey("DEV");
  } catch (e) {
    // A malformed key must not surface as a Node stack trace.
    console.error(red(`\n✘ Cannot start: BAD_PRIVATE_KEY`));
    console.error(`  ${describeError(e)}`);
    console.error(`  ${yellow("→")} Re-run \`pnpm wallets --force\`, or fix DEV_PRIVATE_KEY in .env by hand.\n`);
    process.exit(1);
  }
  if (!key) {
    console.error(red("✘ DEV_PRIVATE_KEY is empty."));
    console.error(`  ${yellow("→")} Run ${bold("pnpm wallets")}, fund the DEV address, then retry.`);
    process.exit(1);
  }
  const account = privateKeyToAccount(key);
  const dex = createDexOrExit(key);
  const d = dex.cfg.collateral.decimals;
  const notes: string[] = [];

  try {
    // ── Preflight ────────────────────────────────────────────────────────────
    heading("1. Preflight");
    const { chainId } = await assertLiveTestnet(dex);
    kv("chain", `${chainId} (Shannon)`);
    kv("wallet", account.address);

    const collateral = dex.cfg.collateral.address;
    if (!collateral) throw new DexError("UNKNOWN", "No collateral address from the SDK.");

    const [stt, tusdc] = await Promise.all([
      dex.rpc.getBalance({ address: account.address }),
      dex.rpc.readContract({ address: collateral, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    ]);
    kv("STT (gas)", formatStt(stt));
    kv("tUSDC", formatFixed(tusdc, d, 2));

    // Balance checks happen BEFORE signing so the user gets a faucet link, not
    // a revert (AGENTS.md §5 — funds & transactions).
    if (stt === 0n) {
      throw new DexError("INSUFFICIENT_GAS", "0 STT — no gas to send a transaction.", `Get STT: ${LINKS.faucet}`);
    }
    if (stt < 600_000_000_000_000_000n) {
      notes.push(`Low STT (${formatStt(stt)}); the SDK's 10M gas ceiling wants ~0.6 STT funded.`);
      console.log(`  ${yellow("!")} Low STT — the mempool admits a tx only when its gas ceiling is funded.`);
    }

    const trader = dex.exchange.client.createTrader({ privateKey: key, decimals: d });

    // ── Claim-only mode ──────────────────────────────────────────────────────
    if (CLAIM_ONLY) {
      heading("2. Sweeping unredeemed winnings");
      const { claimed, total } = await claimAll(dex, account.address, trader);
      console.log(`\n  ${green(`Claimed ${claimed} position(s)`)}, ≈${formatFixed(total, d, 2)} tUSDC.\n`);
      dex.close();
      process.exit(0);
    }

    const stake = BigInt(dex.cfg.stakeTusdc) * 10n ** BigInt(d);
    if (tusdc < stake) {
      throw new DexError(
        "INSUFFICIENT_STAKE",
        `Need ${formatFixed(stake, d, 2)} tUSDC to stake, wallet holds ${formatFixed(tusdc, d, 2)}.`,
        `Mint tUSDC at ${LINKS.faucet}, or lower STAKE_TUSDC in .env.`,
      );
    }

    // ── Pick a window ────────────────────────────────────────────────────────
    const asset = (val("--asset") ?? dex.cfg.targetAsset).toUpperCase();
    const intervalArg = val("--interval");
    const intervalSec = intervalArg ? Number(intervalArg) : dex.cfg.targetIntervalSec;
    if (!Number.isInteger(intervalSec) || intervalSec <= 0) {
      throw new DexError("UNKNOWN", `--interval must be a positive whole number of seconds, got "${intervalArg}".`,
        "Live series are typically 60, 300, 900, 3600, 14400 or 86400 — run `pnpm survey` to see what is open.");
    }
    if (asset !== "BTC" && asset !== "ETH") {
      throw new DexError("NO_MARKETS", `Unknown asset "${asset}".`, "Only BTC and ETH have Event Contract windows.");
    }

    heading(`2. Selecting a ${asset} window`);
    let candidates = await findTradableWindows(dex, { asset, intervalSec });
    if (candidates.length === 0) {
      console.log(`  ${yellow("!")} No ${intervalSec}s window open right now; considering every live series.`);
      notes.push(`Requested ${intervalSec}s series was unavailable at run time; used another series.`);
      candidates = await findTradableWindows(dex, { asset });
    }
    if (candidates.length === 0) {
      throw new DexError("NO_MARKETS", `No tradable ${asset} windows right now.`, "Windows respawn on a schedule — retry shortly.");
    }

    // Settle-soonest-first. The probe has to be *observed* settling, so a 24h
    // window is useless here even though it has the most headroom. Windows that
    // would outlast MAX_PROBE_WAIT_SEC are kept only as a last resort.
    candidates.sort((a, b) => a.secondsLeft - b.secondsLeft);
    const soon = candidates.filter((c) => c.secondsLeft <= MAX_PROBE_WAIT_SEC);
    const ordered = soon.length > 0 ? [...soon, ...candidates.filter((c) => c.secondsLeft > MAX_PROBE_WAIT_SEC)] : candidates;

    // Liquidity is per window AND per side, so selection and quoting are one
    // search: take the first window that can actually fill the stake.
    const preferred: BuySide = sideOf(SIDE_ARG);
    const sidesToTry: BuySide[] = SIDE_EXPLICIT
      ? [preferred]
      : [preferred, preferred === "BUY_YES" ? "BUY_NO" : "BUY_YES"];

    let chosen: (typeof ordered)[number] | undefined;
    let quote: Awaited<ReturnType<typeof quoteStakeOnChain>> = null;
    let BUY_SIDE: BuySide = preferred;
    const rejected: string[] = [];

    for (const cand of ordered) {
      for (const side of sidesToTry) {
        const q = await quoteStakeOnChain(dex, cand.onchain.pool, side, stake);
        if (q && q.quantity > 0n) {
          chosen = cand; quote = q; BUY_SIDE = side;
          break;
        }
      }
      if (chosen) break;
      rejected.push(`${cand.market.intervalSec ?? "?"}s window (closes in ${Math.round(cand.secondsLeft)}s): no fillable asks`);
    }

    if (!chosen || !quote) {
      const tried = sidesToTry.map(labelOf).join(" or ");
      throw new DexError(
        "NO_LIQUIDITY",
        `Checked ${ordered.length} live ${asset} window(s); none had resting asks on ${tried}.`,
        SIDE_EXPLICIT
          ? `Drop --side to let the probe take whichever side has liquidity, or retry shortly.`
          : `Retry in a minute — makers quote intermittently on testnet. Or try --asset ${asset === "BTC" ? "ETH" : "BTC"}.`,
      );
    }
    for (const r of rejected) info(`skipped ${r}`);

    const market: BinaryMarket = chosen.market;
    const onchain: MarketOnchain = chosen.onchain;

    if (!SIDE_EXPLICIT && BUY_SIDE !== preferred) {
      console.log(`  ${yellow("!")} ${labelOf(preferred)} had no asks; taking ${bold(labelOf(BUY_SIDE))} instead.`);
      notes.push(`Auto-selected ${labelOf(BUY_SIDE)}: it was the only side with resting asks.`);
    }
    if (chosen.secondsLeft > MAX_PROBE_WAIT_SEC) {
      console.log(`  ${yellow("!")} Only a long window had liquidity — settlement is ${Math.round(chosen.secondsLeft / 60)} min away.`);
      notes.push(`Probe used a ${market.intervalSec}s window; settlement wait was long.`);
    }

    kv("marketId", market.marketId);
    kv("question", market.question);
    kv("series", `${market.intervalSec ?? "?"}s`);
    kv("venueId", market.venueId ?? "—");
    kv("strike", market.strike);
    kv("closes in", `${Math.round(chosen.secondsLeft)}s`);
    kv("pool", onchain.pool);

    // ── Quote ────────────────────────────────────────────────────────────────
    heading("3. Quoting the stake");
    const bookParams = await dex.exchange.client.getBinaryBookParams(onchain.pool);
    kv("tick / lot / min", `${bookParams.tickSize} / ${bookParams.lotSize} / ${bookParams.minQuantity}`);
    if (quote.quantity < bookParams.minQuantity) {
      throw new DexError(
        "INSUFFICIENT_STAKE",
        `Stake buys ${formatFixed(quote.quantity, d, 4)} contracts, below the venue minimum of ${formatFixed(bookParams.minQuantity, d, 4)}.`,
        "Raise STAKE_TUSDC in .env.",
      );
    }

    kv("side", `${labelOf(BUY_SIDE)} (${BUY_SIDE})`);
    kv("limit price", `${quote.limitPrice}  (${priceToPercent(quote.limitPrice, d)} implied)`);
    kv("quantity", `${formatFixed(quote.quantity, d, 4)} contracts  ${dim(`(raw ${quote.quantity})`)}`);
    kv("escrow", `${formatFixed(quote.escrow, d, 4)} tUSDC`);
    kv("max payout", `${formatFixed(quote.quantity, d, 4)} tUSDC  ${dim("(1 tUSDC per winning contract)")}`);

    if (quote.escrow > tusdc) {
      throw new DexError("INSUFFICIENT_STAKE", `Escrow ${formatFixed(quote.escrow, d, 2)} exceeds balance.`, `Fund at ${LINKS.faucet}`);
    }

    if (DRY_RUN) {
      console.log(`\n  ${blue("Dry run complete — nothing signed.")}`);
      console.log(`  ${dim("Re-run without --dry-run to place this order.")}\n`);
      dex.close();
      process.exit(0);
    }

    if (!(await confirm(`Place this order for ${formatFixed(quote.escrow, d, 4)} tUSDC?`))) {
      console.log(dim("\n  Cancelled — nothing signed.\n"));
      dex.close();
      process.exit(0);
    }

    // ── Place ────────────────────────────────────────────────────────────────
    heading("4. Placing the order");

    // Re-check on-chain status immediately before sending: the window may have
    // locked while we were quoting or waiting for confirmation.
    const fresh = await dex.exchange.client.getMarketOnchain(market.marketId);
    if (fresh.status !== STATUS_TRADING) {
      throw new DexError(
        "WINDOW_CLOSED",
        `Window locked while composing (on-chain status ${fresh.status}).`,
        "Re-run — the next window will be picked up automatically.",
      );
    }

    const interval = Number(market.intervalSec ?? intervalSec);
    // Order expiry is mandatory and capped at the market's own expiry. Sit just
    // inside it so a crashed run leaves nothing resting on the book.
    const nowSec = Math.floor(Date.now() / 1000);
    const expireSec = Math.min(Number(market.expiry) - 1, nowSec + Math.max(30, headroomSecFor(interval)));
    // Quoting and confirming take real time; the window can reach its expiry in
    // between. An order whose expiry is already past is dead on arrival, so stop
    // here rather than burn gas discovering that on-chain.
    if (expireSec <= nowSec + 2) {
      throw new DexError(
        "WINDOW_CLOSED",
        `Window expires in ${Number(market.expiry) - nowSec}s — too close to place an order that would live.`,
        "Re-run; the next window is picked up automatically.",
      );
    }
    const userData = idempotencyKey(account.address, market.marketId);

    console.log(dim(`  FILL_OR_KILL taker order, expires in ${expireSec - Math.floor(Date.now() / 1000)}s, userData=${userData}`));

    const placed = await trader.placeOrder({
      pool: onchain.pool,
      side: BUY_SIDE,
      price: quote.limitPrice,
      quantity: quote.quantity,
      orderType: ORDER_TYPE.FILL_OR_KILL,
      expireTimestampNs: BigInt(expireSec) * 1_000_000_000n,
      autoApprove: true,
      userData,
    });

    // A reverted SDK write resolves rather than throwing — inspect the receipt
    // or a failed order silently becomes a phantom pending row.
    if (placed.receipt.status === "reverted") {
      throw new DexError(
        "ORDER_REJECTED",
        `Order reverted on-chain. ${explorerTx(placed.hash)}`,
        "Common causes: window locked, price off the tick grid, or escrow short.",
      );
    }

    const filled = placed.fills.reduce((sum, f) => sum + f.quantityFilled, 0n);
    const orderStatus = filled === 0n ? "unfilled" : filled < quote.quantity ? "partial" : "filled";
    console.log(`  ${green("✔")} tx ${explorerTx(placed.hash)}`);
    kv("order id", placed.orderId?.toString() ?? "—");
    kv("filled", `${formatFixed(filled, d, 4)} / ${formatFixed(quote.quantity, d, 4)} contracts (${orderStatus})`);
    for (const f of placed.fills) {
      info(`fill ${formatFixed(f.quantityFilled, d, 4)} @ ${priceToPercent(f.fillPrice, d)}`);
    }
    if (orderStatus === "unfilled") {
      notes.push("Order did not fill — FILL_OR_KILL means nothing rested on the book.");
      console.log(`  ${yellow("!")} Nothing filled. No position was opened; no escrow is locked.`);
    }

    const artifact: Artifact = {
      recordedAt: new Date().toISOString(),
      chainId, wallet: account.address, asset,
      intervalSec: market.intervalSec ? Number(market.intervalSec) : null,
      marketId: market.marketId, pool: onchain.pool, venueId: market.venueId ?? null,
      question: market.question, strike: market.strike, expiry: market.expiry,
      side: BUY_SIDE,
      stakeTusdc: formatFixed(stake, d, 6),
      limitPrice: quote.limitPrice.toString(),
      quantity: quote.quantity.toString(),
      escrow: quote.escrow.toString(),
      orderTxHash: placed.hash,
      orderStatus,
      fills: placed.fills.map((f) => ({ quantity: f.quantityFilled.toString(), price: f.fillPrice.toString() })),
      settlement: null, outcome: null, redeemTxHash: null, payoutTusdc: null, notes,
    };
    const save = (): void => {
      if (!existsSync(ARTIFACT_DIR)) mkdirSync(ARTIFACT_DIR, { recursive: true });
      writeFileSync(ARTIFACT_PATH, JSON.stringify(artifact, null, 2));
    };
    save();

    if (orderStatus === "unfilled") {
      console.log(`\n  ${yellow("Exit gate not met")} — an order that never filled cannot settle.`);
      console.log(`  ${yellow("→")} Retry — the probe re-picks a window with resting asks each run.\n`);
      dex.close();
      process.exit(1);
    }

    // ── Await settlement ─────────────────────────────────────────────────────
    heading("5. Awaiting settlement");
    const secondsToExpiry = Number(market.expiry) - Math.floor(Date.now() / 1000);
    console.log(dim(`  Window expires in ${secondsToExpiry}s; settlement follows shortly after.`));
    console.log(dim("  Polling the chain — polling is the guarantee, the live feed is only an optimisation."));

    let lastStatus = -1;
    const settlement = await awaitSettlement(dex, market.marketId, {
      timeoutMs: (Math.max(secondsToExpiry, 0) + 300) * 1000,
      intervalMs: 5_000,
      onTick: (o, elapsed) => {
        if (o.status !== lastStatus) {
          lastStatus = o.status;
          const label = o.status === 1 ? "Trading" : o.status === 2 ? "Locked" : `status ${o.status}`;
          console.log(`  ${dim(`[${Math.round(elapsed / 1000)}s]`)} ${label}`);
        }
      },
    });

    artifact.settlement = { status: settlement.status, winningOutcome: settlement.winningOutcome };

    if (settlement.status === "VOIDED") {
      artifact.outcome = "VOID";
      console.log(`  ${blue("VOIDED")} — both sides redeem 0.5 tUSDC per contract. A refund, not a loss.`);
      notes.push("Window voided; VOID is a real, common outcome on testnet.");
    } else {
      // outcome index 0 = Up, 1 = Down
      const boughtIdx = BUY_SIDE === "BUY_YES" ? 0 : 1;
      const won = settlement.winningOutcome === boughtIdx;
      artifact.outcome = won ? "WON" : "LOST";
      const winnerLabel = settlement.winningOutcome === 0 ? "Up" : "Down";
      console.log(`  ${won ? green("WON") : red("LOST")} — winning outcome was ${bold(winnerLabel)}.`);
    }
    save();

    // ── Redeem ───────────────────────────────────────────────────────────────
    heading("6. Redeeming");
    console.log(dim("  Settlement moves no funds by itself — winnings must be claimed."));
    const before = await dex.rpc.readContract({ address: collateral, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });

    // The settlement record can lag the finalisation by a moment.
    await sleep(3_000);

    // Chain-first: redeem the position we know we hold, no indexer involved.
    const boughtIdx: 0 | 1 = BUY_SIDE === "BUY_YES" ? 0 : 1;
    const txs: string[] = [];
    if (artifact.outcome === "WON" || artifact.outcome === "VOID") {
      const direct = await redeemKnownPosition(dex, account.address, trader, market.marketId, boughtIdx);
      if (direct) txs.push(direct.hash);
      // A void pays BOTH sides 0.5, so the other leg is claimable too if held.
      if (artifact.outcome === "VOID") {
        const other = await redeemKnownPosition(dex, account.address, trader, market.marketId, boughtIdx === 0 ? 1 : 0);
        if (other) txs.push(other.hash);
      }
    }
    // Then sweep anything else left over from earlier runs.
    const swept = await claimAll(dex, account.address, trader);
    txs.push(...swept.txs);

    if (txs.length > 0) {
      artifact.redeemTxHash = txs[0] ?? null;
      const after = await dex.rpc.readContract({ address: collateral, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
      artifact.payoutTusdc = formatFixed(after - before, d, 6);
      kv("balance delta", `${formatFixed(after - before, d, 4)} tUSDC`);
    } else if (artifact.outcome === "LOST") {
      notes.push("Nothing to redeem — a losing position has no claim.");
      info("Nothing claimable, as expected for a losing call.");
    }
    save();

    // ── Done ─────────────────────────────────────────────────────────────────
    heading("Phase 0 exit gate");
    console.log(`  ${green("✔")} One Event Contract order placed, settled and reconciled on Shannon.`);
    kv("order tx", explorerTx(artifact.orderTxHash));
    if (artifact.redeemTxHash) kv("redeem tx", explorerTx(artifact.redeemTxHash));
    kv("outcome", artifact.outcome ?? "—");
    kv("artifact", ARTIFACT_PATH.replace(REPO_ROOT + "/", ""));
    console.log(`\n  ${dim("Record the order tx hash in docs/dex-notes.md — the gate requires it.")}\n`);

    dex.close();
    process.exit(0);
  } catch (e) {
    console.log(`\n${red("✘ Probe failed")}`);
    if (e instanceof DexError) {
      console.log(`  ${bold(e.code)}: ${e.message}`);
      if (e.action) console.log(`  ${yellow("→")} ${e.action}`);
    } else {
      console.log(`  ${describeError(e)}`);
    }
    dex.close();
    process.exit(1);
  }
}

void main();
