/**
 * `pnpm claim` — sweep unredeemed winnings.
 *
 * Winnings are CLAIMED, not received: a settled market pays out only when
 * someone asks it to, so a wallet that trades and never redeems reads near zero
 * while its balance sits across finalised markets.
 *
 * Chain-first by design. The indexer's Portfolio query is used only to find
 * candidate markets, and its failure degrades the sweep rather than stopping it
 * \u2014 a real Phase 0 run lost a won position to exactly that failure.
 */
import { privateKeyToAccount } from "viem/accounts";
import { redeem, getSettlement, statusFor, formatFixed, DexError, type Direction } from "@predictarena/dex";
import { createClientOrExit, getPrivateKey, WALLET_SLOTS, type WalletSlot } from "./lib/env.js";
import { bold, dim, green, yellow, red, heading, kv, info, describeError } from "./lib/log.js";

const ARGS = process.argv.slice(2);
const val = (f: string): string | undefined => {
  const i = ARGS.indexOf(f);
  return i >= 0 ? ARGS[i + 1] : undefined;
};

const slotArg = val("--slot")?.toUpperCase();
if (slotArg && !WALLET_SLOTS.includes(slotArg as WalletSlot)) {
  console.error(red(`--slot must be one of ${WALLET_SLOTS.join(", ")}, got "${slotArg}".`));
  process.exit(2);
}
const SLOT = (slotArg as WalletSlot | undefined) ?? "DEV";

async function main(): Promise<void> {
  console.log(bold("\nPrediction Leagues \u2014 claim winnings"));
  const key = getPrivateKey(SLOT);
  if (!key) {
    console.error(red(`\u2718 ${SLOT}_PRIVATE_KEY is empty.`));
    process.exit(1);
  }
  const account = privateKeyToAccount(key);
  const { client } = createClientOrExit({ slot: SLOT });
  const d = client.collateral.decimals;

  try {
    heading(SLOT);
    kv("address", account.address);

    let candidates: Array<{ marketId: `0x${string}`; outcomeIdx: 0 | 1 }> = [];
    try {
      const claimable = await client.exchange.client.getClaimable(account.address);
      candidates = claimable
        .filter((c) => c.amount > 0n)
        .map((c) => ({ marketId: c.marketId as `0x${string}`, outcomeIdx: c.outcomeIdx }));
    } catch (e) {
      console.log(`  ${yellow("!")} Indexer claim lookup failed: ${describeError(e)}`);
      console.log(`    ${dim("Pass --market <marketId> --direction up|down to redeem a known position without it.")}`);
    }

    const marketArg = val("--market");
    const dirArg = val("--direction")?.toLowerCase();
    if (marketArg) {
      const direction: Direction = dirArg === "down" ? "DOWN" : "UP";
      candidates = [{ marketId: marketArg as `0x${string}`, outcomeIdx: direction === "UP" ? 0 : 1 }];
    }

    if (candidates.length === 0) {
      info("Nothing to claim.");
      client.close();
      process.exit(0);
    }

    let total = 0n;
    let claimed = 0;
    for (const c of candidates) {
      const direction: Direction = c.outcomeIdx === 0 ? "UP" : "DOWN";
      const settlement = await getSettlement(client, c.marketId);
      const status = statusFor(settlement, direction);
      info(`${c.marketId.slice(0, 14)}\u2026 ${direction} \u2014 ${status}`);
      try {
        // Serialised on purpose: claiming signs from the same key as trading,
        // and two senders on one key race each other's nonce.
        const result = await redeem(client, { marketId: c.marketId, account: account.address, direction });
        if (!result) { info("  nothing held"); continue; }
        total += result.received;
        claimed += 1;
        console.log(`  ${green("\u2714")} +${formatFixed(result.received, d, 4)} ${client.collateral.symbol}  ${result.explorerUrl}`);
      } catch (e) {
        const msg = e instanceof DexError ? `${e.code}: ${e.message}` : describeError(e);
        console.log(`  ${red("\u2718")} ${msg}`);
      }
    }

    heading("Summary");
    console.log(`  ${green(`Claimed ${claimed} position(s)`)}, +${formatFixed(total, d, 4)} ${client.collateral.symbol}.\n`);
    client.close();
    process.exit(0);
  } catch (e) {
    console.log(`\n${red("\u2718 Claim failed:")} ${describeError(e)}\n`);
    client.close();
    process.exit(1);
  }
}

void main();
