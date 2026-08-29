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
 */
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi } from "viem";
import { getPrivateKey, WALLET_SLOTS, LINKS, explorerTx, type WalletSlot } from "./lib/config.js";
import { createDex, assertLiveTestnet } from "./lib/dex.js";
import { formatFixed, formatStt } from "./lib/money.js";
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
const amountArg = val("--amount");
const AMOUNT_WHOLE = amountArg ? BigInt(amountArg) : 10_000n;

/** ~0.6 STT: the SDK's fixed 10M gas ceiling at 60 gwei must be funded up front. */
const GAS_FLOOR = 600_000_000_000_000_000n;

async function main(): Promise<void> {
  console.log(bold("\nPrediction Leagues — tUSDC faucet"));
  console.log(dim("Mints testnet collateral. STT for gas must already be present.\n"));

  const dex = createDex();
  const d = dex.cfg.collateral.decimals;
  const collateral = dex.cfg.collateral.address;

  try {
    await assertLiveTestnet(dex);
    if (!collateral) throw new Error("SDK exposed no collateral address.");

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
