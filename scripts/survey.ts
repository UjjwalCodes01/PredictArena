/**
 * `pnpm survey` — where is the liquidity right now?
 *
 * Liquidity on testnet is intermittent and per-window, and gaps at every window
 * roll. This is the tool that says whether a call will actually fill before you
 * try. Read-only; signs nothing.
 */
import { getWindows, quoteCall, formatFixed, MarketStatus, type Direction } from "@predictarena/dex";
import { createClientOrExit } from "./lib/env.js";
import { bold, dim, green, yellow, red, heading, describeError } from "./lib/log.js";

const ARGS = process.argv.slice(2);
const val = (f: string): string | undefined => {
  const i = ARGS.indexOf(f);
  return i >= 0 ? ARGS[i + 1] : undefined;
};

async function main(): Promise<void> {
  console.log(bold("\nLive Up/Down windows \u2014 liquidity survey"));
  const { client, env } = createClientOrExit();
  const d = client.collateral.decimals;
  const asset = val("--asset")?.toUpperCase();
  const stakeWhole = Number(val("--stake") ?? env.stakeWhole);
  const stake = BigInt(Math.round(stakeWhole)) * 10n ** BigInt(d);

  try {
    const windows = await getWindows(client, {
      ...(asset ? { asset } : {}),
      includeUntradable: true,
      limit: 60,
    });

    heading(`${windows.length} live window(s)`);
    console.log(dim("  asset  series   closes  status    Up ask   Down ask   fillable"));
    console.log(dim("  " + "\u2500".repeat(64)));

    let fillable = 0;
    for (const w of windows) {
      let up: bigint | undefined;
      let down: bigint | undefined;
      if (w.status === MarketStatus.Trading) {
        for (const dir of ["UP", "DOWN"] as Direction[]) {
          const q = await quoteCall(client, { window: w, direction: dir, stake }).catch(() => null);
          if (q) { if (dir === "UP") up = q.limitPrice; else down = q.limitPrice; }
        }
      }
      const px = (v: bigint | undefined): string => (v === undefined ? "   \u2014  " : formatFixed(v, d, 3).padStart(6));
      const sides = [up !== undefined ? "Up" : null, down !== undefined ? "Down" : null].filter(Boolean);
      if (sides.length > 0) fillable += 1;
      const label = w.status === MarketStatus.Trading ? "Trading" : `status ${w.status}`;
      console.log(
        `  ${w.asset.padEnd(6)} ${String(w.intervalSec ?? "?").padStart(6)}s ` +
        `${String(Math.round(w.secondsLeft)).padStart(6)}s  ${label.padEnd(9)} ${px(up)}   ${px(down)}     ` +
        (sides.length > 0 ? green(sides.join("+")) : dim("none")),
      );
    }

    heading("Read");
    console.log(`  Prices are the cost per contract; a winning contract redeems for 1 ${client.collateral.symbol}.`);
    console.log(`  Quoted against a ${formatFixed(stake, d, 2)} ${client.collateral.symbol} stake, from the chain's book.`);
    if (fillable === 0) {
      console.log(`\n  ${yellow("No window can be filled right now.")}`);
      console.log(`  ${dim("Makers quote intermittently \u2014 re-run in a minute.")}\n`);
    } else {
      console.log(`\n  ${green(`${fillable} window(s) fillable now.`)}`);
      console.log(`  ${dim("`pnpm smoke` picks the soonest-settling one with a fillable side.")}\n`);
    }
    client.close();
    process.exit(0);
  } catch (e) {
    console.log(`\n${red("\u2718 Survey failed:")} ${describeError(e)}\n`);
    client.close();
    process.exit(1);
  }
}

void main();
