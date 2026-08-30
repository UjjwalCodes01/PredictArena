/**
 * Network constants and the testnet-only safety rail.
 *
 * CLAUDE.md hard rule 1 is "testnet only". That rule CANNOT be enforced by an
 * address allowlist: 8 of the 11 protocol contracts are byte-identical on
 * mainnet and testnet because they are deployed via CREATE3
 * (docs/dex-notes.md §7). The only real discriminators are the chain id, the
 * collateral token, and the endpoint hostnames — so all three are asserted, and
 * nothing else in the codebase is trusted to do it.
 */
import { SOMNIA_TESTNET_ADDRESSES, DEFAULT_FEES } from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { DexError } from "./errors";

/** Somnia Shannon. The only chain this project may touch. */
export const TESTNET_CHAIN_ID = 50312 as const;
/** Somnia mainnet. Present only so we can refuse it loudly. */
export const MAINNET_CHAIN_ID = 5031 as const;
/** Somnia Elwood — a different testnet. Event Contracts we target are on Shannon. */
export const ELWOOD_CHAIN_ID = 50313 as const;

/** Hosts that serve mainnet. A URL containing any of these is a hard stop. */
export const MAINNET_HOSTS = [
  "api.infra.mainnet.somnia.network",
  "api.dreamdex.io",
  "prd.smk.somnia.host",
] as const;

/** Mainnet collateral (USDso, 18dp). Detected so we can refuse it. */
export const MAINNET_COLLATERAL = "0x00000022da000002656c64d9ea6011ea952d008a";

/**
 * Testnet collateral: tUSDC, 6 decimals. NOT USDso — that token is mainnet-only
 * and has no bytecode on Shannon.
 *
 * These are EXPECTATIONS, not truth. `assertLiveNetwork()` reads both from the
 * token contract and refuses to continue if either differs, then replaces the
 * symbol on the client with the chain's own value — so nothing ever displays a
 * label the chain did not confirm.
 */
export const EXPECTED_COLLATERAL_DECIMALS = 6 as const;
export const EXPECTED_COLLATERAL_SYMBOL = "tUSDC" as const;

/**
 * The SDK sends every write with a fixed gas ceiling and never estimates, and
 * the mempool admits a transaction only when that ceiling is funded on top of
 * its value. So a wallet needs the whole envelope present even though the
 * unused remainder is refunded — checking for "> 0" would pass a wallet that
 * still cannot transact.
 *
 * Derived, not hardcoded: the fee comes from the SDK's own `DEFAULT_FEES`, so
 * if the SDK changes its gas price this constant follows. The 10M gas limit is
 * the SDK's `DEFAULT_GAS`, which it documents but does not export at runtime —
 * so that single number is mirrored here and asserted in the tests.
 */
export const SDK_DEFAULT_GAS = 10_000_000n;
export const GAS_CEILING_WEI = SDK_DEFAULT_GAS * DEFAULT_FEES.maxFeePerGas;

export const SHANNON = somniaShannon;
export const TESTNET_ADDRESSES = SOMNIA_TESTNET_ADDRESSES;

export const LINKS = {
  faucet: "https://testnet.somnia.network",
  explorer: "https://shannon-explorer.somnia.network",
  docs: "https://docs.dreamdex.io/developers/event-contracts",
} as const;

export const explorerTx = (hash: string): string => `${LINKS.explorer}/tx/${hash}`;
export const explorerAddress = (address: string): string => `${LINKS.explorer}/address/${address}`;

/** Throws if anything in the supplied config points at mainnet or the wrong chain. */
export function assertTestnetConfig(input: { chainId?: number; urls: readonly (string | undefined)[] }): void {
  const chainId = input.chainId ?? TESTNET_CHAIN_ID;
  if (chainId === MAINNET_CHAIN_ID) {
    throw new DexError("MAINNET_FORBIDDEN", `Chain ${MAINNET_CHAIN_ID} is Somnia mainnet.`, {
      action: "This project is testnet-only (CLAUDE.md rule 1). Use chain 50312.",
    });
  }
  if (chainId !== TESTNET_CHAIN_ID) {
    throw new DexError("CHAIN_MISMATCH", `Chain ${chainId} is not Shannon (${TESTNET_CHAIN_ID}).`, {
      action:
        chainId === ELWOOD_CHAIN_ID
          ? "50313 is Elwood, a different Somnia testnet. Event Contracts are on Shannon."
          : "Set the chain to 50312.",
    });
  }
  for (const url of input.urls) {
    if (!url) continue;
    const host = MAINNET_HOSTS.find((h) => url.toLowerCase().includes(h));
    if (host) {
      throw new DexError("MAINNET_FORBIDDEN", `Endpoint "${url}" is the mainnet host "${host}".`, {
        action: "This project is testnet-only (CLAUDE.md rule 1).",
      });
    }
  }
}
