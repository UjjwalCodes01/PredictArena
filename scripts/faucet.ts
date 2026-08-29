/**
 * `pnpm faucet` — mint tUSDC to the burner wallets.
 *
 * The testnet collateral contract exposes `faucet(uint256)` (verified: the
 * selector 0x57915897 is present in the tUSDC bytecode), so a wallet can mint
 * its own stake once it holds STT for gas. That leaves exactly one manual step
 * in Phase 0 funding: getting STT from the web faucet.
 *
 * Flags:
 *   --slot DEV|SEED1|SEED2|SEED3   just one wallet (default: all configured)
 *   --amount <whole tUSDC>         default 10000, the contract's own default
 *   --fund-seeds                   send STT from DEV to SEED1..3 first
 *
 * `--fund-seeds` exists because the external STT faucet is rate-limited to one
 * claim per 24h, which would otherwise make "four funded wallets" a three-day
 * job. DEV already holds far more STT than the whole build needs, so it seeds
 * the others directly.
 */
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi } from "viem";
import { createWalletClient, http } from "viem";
import { assertLiveNetwork, explorerTx, formatFixed, formatStt, SHANNON, type DexClient } from "@predictarena/dex";
import { createClientOrExit, getPrivateKey, WALLET_SLOTS, LINKS, type WalletSlot } from "./lib/env.js";
import { bold, dim, green, yellow, red, heading, kv, describeError } from "./lib/log.js";

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
const amountArg = val("--amount");
if (amountArg !== undefined && !/^\d+$/.test(amountArg.trim())) {
  console.error(red(`--amount must be a whole number of tUSDC, got "${amountArg}".`));
  process.exit(2);
}
const AMOUNT_WHOLE = amountArg ? BigInt(amountArg.trim()) : 10_000n;

/** ~0.6 STT: the SDK's fixed 10M gas ceiling at 60 gwei must be funded up front. */
const GAS_FLOOR = 600_000_000_000_000_000n;
/** Enough for a gas ceiling plus a comfortable margin of real transactions. */
const SEED_GRANT = 2_000_000_000_000_000_000n;
const FUND_SEEDS = ARGS.includes("--fund-seeds");

/**
 * Tops up SEED1..3 from DEV so every wallet can transact. Sends are serialised:
 * they all originate from the DEV key, and two senders on one key race each
 * other's nonce.
 */
async function fundSeedsFromDev(dex: DexClient): Promise<void> {
  const devKey = getPrivateKey("DEV");
  if (!devKey) {
    console.log(`  ${red("✘")} DEV_PRIVATE_KEY is empty — nothing to fund from.`);
    return;
  }
  const dev = privateKeyToAccount(devKey);
  const devBalance = await dex.rpc.getBalance({ address: dev.address });

  type SeedSlot = "SEED1" | "SEED2" | "SEED3";
  const targets: Array<{ slot: SeedSlot; key: `0x${string}` }> = [];
  for (const slot of ["SEED1", "SEED2", "SEED3"] as const) {
    const key = getPrivateKey(slot);
    if (key) targets.push({ slot, key });
  }

  const needed = SEED_GRANT * BigInt(targets.length) + GAS_FLOOR;
  if (devBalance < needed) {
    console.log(`  ${yellow("!")} DEV holds ${formatStt(devBalance)} STT; needs ~${formatStt(needed)} to seed ${targets.length} wallet(s).`);
    return;
  }

  const wallet = createWalletClient({ account: dev, chain: SHANNON, transport: http(dex.config.rpcHttpUrl) });

  for (const { slot, key } of targets) {
    const to = privateKeyToAccount(key).address;
    const have = await dex.rpc.getBalance({ address: to });
    if (have >= GAS_FLOOR) {
      console.log(`  ${dim(`${slot} already holds ${formatStt(have)} STT — skipping`)}`);
      continue;
    }
    const hash = await wallet.sendTransaction({ to, value: SEED_GRANT });
    const receipt = await dex.rpc.waitForTransactionReceipt({ hash });
    if (receipt.status === "reverted") {
      console.log(`  ${red("✘")} ${slot} transfer reverted ${explorerTx(hash)}`);
      continue;
    }
    console.log(`  ${green("✔")} ${slot} +${formatStt(SEED_GRANT)} STT  ${explorerTx(hash)}`);
  }
}

async function main(): Promise<void> {
  console.log(bold("\nPrediction Leagues — tUSDC faucet"));
  console.log(dim("Mints testnet collateral. STT for gas must already be present.\n"));

  const { client: dex } = createClientOrExit();
  const d = dex.collateral.decimals;
  const collateral = dex.collateral.address;

  try {
    await assertLiveNetwork(dex);
    if (!collateral) throw new Error("SDK exposed no collateral address.");

    if (FUND_SEEDS) {
      heading("Seeding STT from DEV");
      await fundSeedsFromDev(dex);
    }

    const slots = slotArg ? [slotArg as WalletSlot] : [...WALLET_SLOTS];
    const amount = AMOUNT_WHOLE * 10n ** BigInt(d);
    let minted = 0;
    let needStt = 0;

    for (const slot of slots) {
      heading(slot);
      let key: `0x${string}` | undefined;
      try {
        key = getPrivateKey(slot);
      } catch (e) {
        console.log(`  ${red("✘")} ${describeError(e)}`);
        continue;
      }
      if (!key) {
        console.log(`  ${dim("no key configured — skipping")}`);
        continue;
      }

      const account = privateKeyToAccount(key);
      kv("address", account.address);

      const [stt, before] = await Promise.all([
        dex.rpc.getBalance({ address: account.address }),
        dex.rpc.readContract({ address: collateral, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
      ]);
      kv("STT", formatStt(stt));
      kv("tUSDC before", formatFixed(before, d, 2));

      if (stt < GAS_FLOOR) {
        needStt += 1;
        console.log(`  ${yellow("!")} Needs STT first — the mempool only admits a tx whose 10M gas ceiling is funded.`);
        console.log(`    ${yellow("→")} Get STT for ${bold(account.address)} at ${bold(LINKS.faucet)}`);
        continue;
      }

      try {
        // Each wallet is its own signer, so nothing races here — but we still go
        // one at a time: two senders on one key race each other's nonce, and
        // serialising is free.
        const trader = dex.exchange.client.createTrader({ privateKey: key, decimals: d });
        const res = await trader.faucet({ amount });

        // SDK writes resolve even when the transaction reverted.
        if (res.receipt.status === "reverted") {
          console.log(`  ${red("✘ faucet reverted")} ${explorerTx(res.hash)}`);
          console.log(`    ${yellow("→")} The faucet may be rate-limited per address. Try again later or use a different wallet.`);
          continue;
        }

        const after = await dex.rpc.readContract({
          address: collateral, abi: erc20Abi, functionName: "balanceOf", args: [account.address],
        });
        kv("tUSDC after", formatFixed(after, d, 2));
        kv("minted", `+${formatFixed(after - before, d, 2)}`);
        console.log(`  ${green("✔")} ${explorerTx(res.hash)}`);
        minted += 1;
      } catch (e) {
        console.log(`  ${red("✘ faucet failed:")} ${describeError(e)}`);
      }
    }

    heading("Summary");
    console.log(`  ${green(`${minted} wallet(s) funded with tUSDC`)}`);
    if (needStt > 0) {
      console.log(`  ${yellow(`${needStt} wallet(s) still need STT`)} — that is the one step only the web faucet can do.`);
      console.log(`  ${yellow("→")} ${bold(LINKS.faucet)}`);
    }
    console.log(`\n  Next: ${bold("pnpm doctor")}\n`);
    dex.close();
    process.exit(0);
  } catch (e) {
    console.log(`\n${red("✘ Faucet run failed:")} ${describeError(e)}\n`);
    dex.close();
    process.exit(1);
  }
}

void main();
