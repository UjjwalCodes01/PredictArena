/**
 * `pnpm smoke` — the canary for the whole project.
 *
 * PLAN.md Phase 1 exit gate: markets -> place a min-stake call with the dev
 * burner -> poll until settled -> print the result. Exits 0 only on a complete
 * live round-trip against Shannon.
 *
 * This exercises `packages/dex` end to end through its public API and nothing
 * else, so a green smoke means the package the web app and indexer will import
 * actually works — not that a script does.
 *
 * Flags:
 *   --asset BTC|ETH      default from TARGET_ASSET
 *   --interval <sec>     default from TARGET_INTERVAL_SEC
 *   --stake <whole>      default from STAKE_TUSDC
 *   --direction up|down  default: whichever side has liquidity
 *   --dry-run            quote and preflight only; sign nothing
 *   --no-redeem          stop after settlement
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import {
  assertLiveNetwork, getMarkets, getWindows, quoteCall, placeCall, awaitSettlement,
  redeem, statusFor, formatFixed, formatStt, priceToPercent, explorerTx,
  DexError, headroomSecFor,
  type Direction, type Window,
} from "@predictarena/dex";
import { createClientOrExit, getPrivateKey, LINKS, REPO_ROOT } from "./lib/env.js";
import { bold, dim, green, yellow, red, blue, heading, kv, info, describeError } from "./lib/log.js";

const ARGS = process.argv.slice(2);
const has = (f: string): boolean => ARGS.includes(f);
const val = (f: string): string | undefined => {
  const i = ARGS.indexOf(f);
  return i >= 0 ? ARGS[i + 1] : undefined;
};

const DRY_RUN = has("--dry-run");
const NO_REDEEM = has("--no-redeem");

/** Longest window we will sit through: a 24h series cannot be a smoke test. */
const MAX_WAIT_SEC = 20 * 60;

function parseDirection(): Direction | undefined {
  const raw = val("--direction")?.toLowerCase();
  if (raw === undefined) return undefined;
  if (raw !== "up" && raw !== "down") {
    console.error(red(`--direction must be "up" or "down", got "${raw}".`));
    process.exit(2);
  }
  return raw === "up" ? "UP" : "DOWN";
}

async function main(): Promise<void> {
  const started = Date.now();
  console.log(bold("\nPrediction Leagues — smoke test"));
  console.log(dim(DRY_RUN ? "DRY RUN: nothing will be signed.\n" : "Signs and sends REAL testnet transactions.\n"));

  const key = getPrivateKey("DEV");
  if (!key) {
    console.error(red("\u2718 DEV_PRIVATE_KEY is empty."));
    console.error(`  ${yellow("\u2192")} Run ${bold("pnpm wallets")}, fund the DEV address, then retry.\n`);
    process.exit(1);
  }
  const account = privateKeyToAccount(key);
  const { client, env } = createClientOrExit({ slot: "DEV" });

  const asset = (val("--asset") ?? env.targetAsset).toUpperCase();
  const intervalArg = val("--interval");
  const intervalSec = intervalArg ? Number(intervalArg) : env.targetIntervalSec;
  const stakeArg = val("--stake");
  const stakeWhole = stakeArg ? Number(stakeArg) : env.stakeWhole;

  if (!Number.isInteger(intervalSec) || intervalSec <= 0) {
    console.error(red(`--interval must be a positive whole number of seconds, got "${intervalArg}".`));
    process.exit(2);
  }
  if (!Number.isFinite(stakeWhole) || stakeWhole <= 0) {
    console.error(red(`--stake must be positive, got "${stakeArg}".`));
    process.exit(2);
  }

  const d = client.collateral.decimals;
  const stake = BigInt(Math.round(stakeWhole)) * 10n ** BigInt(d);
  const preferred = parseDirection();

  try {
    // ---- 1. Network identity -------------------------------------------------
    heading("1. Network");
    const net = await assertLiveNetwork(client);
    kv("chain", `${net.chainId} (Shannon)`);
    kv("collateral", `${net.collateralSymbol}, ${net.collateralDecimals} dp`);
    kv("clock offset", `${client.clock.offsetSeconds}s vs local`);
    kv("wallet", account.address);

    // ---- 2. Markets ----------------------------------------------------------
    heading("2. Markets");
    const markets = await getMarkets(client);
    kv("assets", markets.assets.join(", "));
    kv("venues", `${markets.venues.length} discovered at runtime`);

    // ---- 3. Windows ----------------------------------------------------------
    heading(`3. Windows: ${asset} @ ${intervalSec}s`);
    let windows = await getWindows(client, { asset, intervalSec });
    if (windows.length === 0) {
      console.log(`  ${yellow("!")} No ${intervalSec}s window open; considering every live series.`);
      windows = await getWindows(client, { asset });
    }
    if (windows.length === 0) {
      throw new DexError("NO_MARKETS", `No tradable ${asset} windows right now.`, {
        action: "Windows respawn on a schedule. Retry shortly, or run `pnpm survey`.",
      });
    }

    // Soonest-settling first: a smoke test has to be observed finishing.
    const ordered = [...windows].sort((a, b) => a.secondsLeft - b.secondsLeft);
    const shortlist = [
      ...ordered.filter((w) => w.secondsLeft <= MAX_WAIT_SEC),
      ...ordered.filter((w) => w.secondsLeft > MAX_WAIT_SEC),
    ];

    // Liquidity is per window AND per side, so selection and quoting are one search.
    const directions: Direction[] = preferred ? [preferred] : ["UP", "DOWN"];
    let chosen: Window | undefined;
    let direction: Direction | undefined;
    let quote = null;

    for (const w of shortlist) {
      for (const dir of directions) {
        const q = await quoteCall(client, { window: w, direction: dir, stake }).catch(() => null);
        if (q) { chosen = w; direction = dir; quote = q; break; }
      }
      if (chosen) break;
      info(`skipped ${w.intervalSec ?? "?"}s window (closes in ${Math.round(w.secondsLeft)}s): no fillable asks`);
    }

    if (!chosen || !direction || !quote) {
      throw new DexError("NO_LIQUIDITY", `Checked ${shortlist.length} ${asset} window(s); none had fillable asks.`, {
        action: "Makers quote intermittently on testnet. Retry in a minute, or run `pnpm survey`.",
      });
    }

    kv("marketId", chosen.marketId);
    kv("question", chosen.question);
    kv("series", `${chosen.intervalSec ?? "?"}s`);
    kv("closes in", `${Math.round(chosen.secondsLeft)}s (headroom ${headroomSecFor(chosen.intervalSec ?? 0)}s)`);

    // ---- 4. Quote ------------------------------------------------------------
    heading("4. Quote");
    kv("direction", direction);
    kv("limit price", `${quote.limitPrice} (${priceToPercent(quote.limitPrice, d)} implied)`);
    kv("quantity", `${formatFixed(quote.quantity, d, 4)} contracts`);
    kv("escrow", `${formatFixed(quote.escrow, d, 4)} ${client.collateral.symbol}`);
    kv("max payout", `${formatFixed(quote.maxPayout, d, 4)} ${client.collateral.symbol}`);

    if (DRY_RUN) {
      console.log(`\n  ${blue("Dry run complete \u2014 nothing signed.")}`);
      console.log(`  ${dim("Re-run without --dry-run for the full round-trip.")}\n`);
      client.close();
      process.exit(0);
    }

    // ---- 5. Place ------------------------------------------------------------
    heading("5. Placing");
    const placed = await placeCall(client, {
      window: chosen, direction, stake, account: account.address,
    });
    console.log(`  ${green("\u2714")} ${placed.explorerUrl}`);
    kv("filled", `${formatFixed(placed.filled, d, 4)} / ${formatFixed(quote.quantity, d, 4)} (${placed.status})`);
    kv("spent", `${formatFixed(placed.spent, d, 4)} ${client.collateral.symbol}`);
    for (const f of placed.fills) {
      info(`fill ${formatFixed(f.quantity, d, 4)} @ ${priceToPercent(f.price, d)}`);
    }

    if (placed.status === "UNFILLED") {
      throw new DexError("ORDER_REJECTED", "Order filled nothing, so there is no position to settle.", {
        action: "Retry: liquidity gaps at window rolls are normal on testnet.",
      });
    }

    // ---- 6. Settlement -------------------------------------------------------
    heading("6. Settlement");
    console.log(dim("  Polling the chain \u2014 polling is the guarantee, the live feed is an optimisation."));
    let lastStatus = -1;
    const settlement = await awaitSettlement(client, chosen.marketId, {
      timeoutMs: (Math.max(chosen.secondsLeft, 0) + 300) * 1000,
      intervalMs: 5_000,
      onTick: (s, elapsed) => {
        if (s.onchainStatus !== lastStatus) {
          lastStatus = s.onchainStatus;
          console.log(`  ${dim(`[${Math.round(elapsed / 1000)}s]`)} on-chain status ${s.onchainStatus}`);
        }
      },
    });

    const outcome = statusFor(settlement, direction);
    kv("settlement", settlement.status);
    kv("winner", settlement.winningDirection ?? "\u2014 (void)");
    console.log(
      `  ${outcome === "WON" ? green(outcome) : outcome === "VOID" ? blue(outcome) : red(outcome)}` +
      `  ${dim(`(called ${direction})`)}`,
    );

    // ---- 7. Redeem -----------------------------------------------------------
    let redeemed = null;
    if (!NO_REDEEM && (outcome === "WON" || outcome === "VOID")) {
      heading("7. Redeem");
      console.log(dim("  Settlement moves no funds by itself \u2014 winnings are claimed."));
      redeemed = await redeem(client, {
        marketId: chosen.marketId, account: account.address, direction,
      });
      if (redeemed) {
        console.log(`  ${green("\u2714")} ${redeemed.explorerUrl}`);
        kv("received", `${formatFixed(redeemed.received, d, 4)} ${client.collateral.symbol}`);
      } else {
        info("Nothing held to redeem.");
      }
    } else if (outcome === "LOST") {
      heading("7. Redeem");
      info("Nothing to redeem \u2014 a losing call has no claim.");
    }

    // ---- Done ---------------------------------------------------------------
    // Record the round-trip. `pnpm gate` verifies this rather than taking our word.
    const artifactDir = resolve(REPO_ROOT, "artifacts");
    if (!existsSync(artifactDir)) mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      resolve(artifactDir, "phase0-probe.json"),
      JSON.stringify({
        recordedAt: new Date().toISOString(),
        chainId: net.chainId,
        wallet: account.address,
        asset,
        intervalSec: chosen.intervalSec,
        marketId: chosen.marketId,
        pool: chosen.pool,
        venueId: chosen.venueId,
        question: chosen.question,
        strike: chosen.strike,
        expiry: String(chosen.closesAtSec),
        side: direction === "UP" ? "BUY_YES" : "BUY_NO",
        stakeTusdc: formatFixed(stake, d, 6),
        limitPrice: quote.limitPrice.toString(),
        quantity: quote.quantity.toString(),
        escrow: quote.escrow.toString(),
        orderTxHash: placed.txHash,
        orderStatus: placed.status === "FILLED" ? "filled" : placed.status === "PARTIAL" ? "partial" : "unfilled",
        fills: placed.fills.map((f) => ({ quantity: f.quantity.toString(), price: f.price.toString() })),
        settlement: { status: settlement.status, winningOutcome: settlement.winningOutcome },
        outcome,
        redeemTxHash: redeemed?.txHash ?? null,
        payoutTusdc: redeemed ? formatFixed(redeemed.received, d, 6) : null,
        notes: ["Written by `pnpm smoke` — a full live round-trip through packages/dex."],
      }, null, 2),
    );

    const sttLeft = await client.rpc.getBalance({ address: account.address });
    heading("Smoke result");
    console.log(`  ${green(bold("PASS"))} \u2014 live round-trip on Shannon in ${Math.round((Date.now() - started) / 1000)}s.`);
    kv("order tx", explorerTx(placed.txHash));
    if (redeemed) kv("redeem tx", explorerTx(redeemed.txHash));
    kv("outcome", outcome);
    kv("STT left", formatStt(sttLeft));
    console.log("");

    client.close();
    process.exit(0);
  } catch (e) {
    heading("Smoke result");
    console.log(`  ${red(bold("FAIL"))}`);
    if (e instanceof DexError) {
      console.log(`  ${bold(e.code)}: ${e.message}`);
      if (e.action) console.log(`  ${yellow("\u2192")} ${e.action}`);
      if (e.code === "INSUFFICIENT_GAS" || e.code === "INSUFFICIENT_STAKE") {
        console.log(`  ${dim(`Faucet: ${LINKS.faucet}`)}`);
      }
    } else {
      console.log(`  ${describeError(e)}`);
    }
    console.log("");
    client.close();
    process.exit(1);
  }
}

void main();
