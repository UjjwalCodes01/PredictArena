/**
 * `pnpm survey` — where is the liquidity right now?
 *
 * Phase 0 recon: lists every live Up/Down window with its on-chain status and
 * the top of book on both outcomes, so "can I actually place a call on this
 * series" is answerable at a glance. Read-only.
 *
 * Liquidity on testnet is intermittent and per-window, so this is the tool that
 * tells you whether `pnpm place-one` will find a fill before you run it.
 */
import { createDex, STATUS_TRADING } from "./lib/dex.js";
import { formatFixed } from "./lib/money.js";
import { bold, dim, green, yellow, red, heading, describeError } from "./lib/log.js";

async function main(): Promise<void> {
  console.log(bold("\nLive Up/Down windows — liquidity survey"));
  const dex = createDex();
  const d = dex.cfg.collateral.decimals;

  try {
    const live = await dex.exchange.client.listLiveBinaryMarkets({ orderBy: "closingSoon", limit: 60 });
    const now = Date.now() / 1000;

    heading(`${live.length} live window(s)`);
    console.log(dim("  asset  series   closes  status   Up ask   Down ask   takeable"));
    console.log(dim("  " + "─".repeat(62)));

    let takeableCount = 0;
    for (const m of live) {
      const left = Math.round(Number(m.expiry) - now);
      if (left <= 0) continue;

      let pool: `0x${string}`;
      let status: number;
      try {
        const oc = await dex.exchange.client.getMarketOnchain(m.marketId);
        pool = oc.pool;
        status = oc.status;
      } catch {
        continue;
      }

      let yesAsk: bigint | undefined;
      let noAsk: bigint | undefined;
      if (status === STATUS_TRADING) {
        try {
          const book = await dex.exchange.client.getBinaryOrderBook(pool, { depth: 3 });
          yesAsk = book.yesAsks?.[0]?.price;
          noAsk = book.noAsks?.[0]?.price;
        } catch { /* book unreadable */ }
      }

      const px = (v: bigint | undefined): string => (v === undefined ? "   —  " : formatFixed(v, d, 3).padStart(6));
      const sides = [yesAsk !== undefined ? "Up" : null, noAsk !== undefined ? "Down" : null].filter(Boolean);
      if (sides.length > 0) takeableCount += 1;
      const takeable = sides.length > 0 ? green(sides.join("+")) : dim("none");
      const statusLabel = status === STATUS_TRADING ? "Trading" : `st=${status}`;

      console.log(
        `  ${(m.asset ?? "?").padEnd(5)} ${String(m.intervalSec ?? "?").padStart(6)}s ` +
        `${String(left).padStart(6)}s  ${statusLabel.padEnd(8)} ${px(yesAsk)}   ${px(noAsk)}     ${takeable}`,
      );
    }

    heading("Read");
    console.log(`  Prices are cost per contract in tUSDC; a winning contract redeems for 1.`);
    console.log(`  "Up ask" is what buying Up costs; "Down ask" what buying Down costs.`);
    if (takeableCount === 0) {
      console.log(`\n  ${yellow("No window has resting asks right now.")}`);
      console.log(`  ${dim("Makers quote intermittently on testnet — re-run in a minute.")}\n`);
    } else {
      console.log(`\n  ${green(`${takeableCount} window(s) can be taken right now.`)}`);
      console.log(`  ${dim("`pnpm place-one` picks the soonest-settling one with a fillable side.")}\n`);
    }
    dex.close();
    process.exit(0);
  } catch (e) {
    console.log(`\n${red("✘ Survey failed:")} ${describeError(e)}\n`);
    dex.close();
    process.exit(1);
  }
}

void main();
