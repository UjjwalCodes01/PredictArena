/**
 * Config + the testnet-only safety rail.
 *
 * CLAUDE.md hard rule 1 is "testnet only". That rule cannot be enforced by an
 * address allowlist: 8 of the 11 protocol contracts are byte-identical on
 * mainnet and testnet (CREATE3 — see docs/dex-notes.md §7). The only real
 * guards are the chain id, the collateral token, and the endpoint hostnames,
 * so all three are asserted here and nothing else in the repo is trusted to.
 *
 * Phase 1 promotes this file into `packages/dex`.
 */
import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import type { Chain } from "viem";

export const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
export const ENV_PATH = resolve(REPO_ROOT, ".env");

loadDotenv({ path: ENV_PATH, quiet: true });

/** Somnia Shannon. The only chain this repo may ever touch. */
export const TESTNET_CHAIN_ID = 50312 as const;

/** Somnia mainnet. Present only so we can refuse it loudly. */
export const MAINNET_CHAIN_ID = 5031 as const;

/**
 * Hostnames that serve mainnet. A URL containing any of these is a hard stop.
 * `prd.smk.somnia.host` is the production indexer and is the easiest of these
 * to configure by accident — the SDK's own README uses it in its first example.
 */
const MAINNET_HOSTS = [
  "api.infra.mainnet.somnia.network",
  "api.dreamdex.io",
  "prd.smk.somnia.host",
] as const;

/**
 * Testnet collateral: tUSDC, 6 decimals. NOT USDso — that token is mainnet-only
 * and has no bytecode on Shannon (verified; docs/dex-notes.md §2).
 */
export const COLLATERAL = {
  address: SOMNIA_TESTNET_ADDRESSES.collateral,
  symbol: "tUSDC",
  decimals: 6,
} as const;

/** The mainnet collateral address, so we can detect it and refuse. */
export const MAINNET_COLLATERAL = "0x00000022dA000002656c64D9eA6011ea952D008A".toLowerCase();

export class ConfigError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
  }
}

function req(key: string, fallback?: string): string {
  const v = process.env[key]?.trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  throw new ConfigError(
    "MISSING_ENV",
    `${key} is not set. Copy .env.example to .env and run \`pnpm wallets\`.`,
  );
}

function num(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new ConfigError("BAD_ENV", `${key}="${raw}" is not a number.`);
  }
  return n;
}

/**
 * Refuses anything that smells like mainnet, scanning every env value rather
 * than only the ones we read — a stray `MAINNET_RPC=` someone pasted in to
 * "just check something" is exactly how this rule gets broken.
 */
export function assertTestnetOnly(): void {
  const chainId = num("CHAIN_ID", TESTNET_CHAIN_ID);
  if (chainId === MAINNET_CHAIN_ID) {
    throw new ConfigError(
      "MAINNET_FORBIDDEN",
      `CHAIN_ID=${MAINNET_CHAIN_ID} is Somnia mainnet. This repo is testnet-only (CLAUDE.md rule 1).`,
    );
  }
  if (chainId !== TESTNET_CHAIN_ID) {
    throw new ConfigError(
      "WRONG_CHAIN",
      `CHAIN_ID=${chainId} is not Shannon (${TESTNET_CHAIN_ID}). ` +
        `Note 50313 is Elwood, a different testnet — the Event Contracts we target are on Shannon.`,
    );
  }

  for (const [key, value] of Object.entries(process.env)) {
    if (!value || typeof value !== "string") continue;
    if (!/^(RPC_|INDEXER_|.*_URL$|.*_RPC$|.*ENDPOINT.*)/i.test(key)) continue;
    const hit = MAINNET_HOSTS.find((h) => value.toLowerCase().includes(h));
    if (hit) {
      throw new ConfigError(
        "MAINNET_FORBIDDEN",
        `${key} points at the mainnet host "${hit}". This repo is testnet-only (CLAUDE.md rule 1).`,
      );
    }
  }

  if (COLLATERAL.address?.toLowerCase() === MAINNET_COLLATERAL) {
    throw new ConfigError(
      "MAINNET_FORBIDDEN",
      "Collateral resolved to the mainnet USDso address. Refusing to continue.",
    );
  }
}

export interface AppConfig {
  readonly chain: Chain;
  readonly chainId: number;
  readonly rpcHttpUrl: string;
  readonly rpcWsUrl: string;
  readonly indexerUrl: string;
  readonly addresses: typeof SOMNIA_TESTNET_ADDRESSES;
  readonly collateral: typeof COLLATERAL;
  readonly targetAsset: string;
  readonly targetIntervalSec: number;
  readonly stakeTusdc: number;
  readonly venueId: string | undefined;
  readonly envFileExists: boolean;
}

export function loadConfig(): AppConfig {
  assertTestnetOnly();
  return {
    chain: somniaShannon,
    chainId: TESTNET_CHAIN_ID,
    rpcHttpUrl: req("RPC_HTTP_URL", "https://dream-rpc.somnia.network"),
    rpcWsUrl: req("RPC_WS_URL", "wss://dream-rpc.somnia.network/ws"),
    indexerUrl: req("INDEXER_URL", "https://dev.smk.somnia.host/v1/graphql"),
    addresses: SOMNIA_TESTNET_ADDRESSES,
    collateral: COLLATERAL,
    targetAsset: req("TARGET_ASSET", "BTC").toUpperCase(),
    targetIntervalSec: num("TARGET_INTERVAL_SEC", 300),
    stakeTusdc: num("STAKE_TUSDC", 1),
    venueId: process.env["VENUE_ID"]?.trim() || undefined,
    envFileExists: existsSync(ENV_PATH),
  };
}

/** Wallet slots. DEV places the probe order; SEED1..3 populate the demo league. */
export const WALLET_SLOTS = ["DEV", "SEED1", "SEED2", "SEED3"] as const;
export type WalletSlot = (typeof WALLET_SLOTS)[number];

const HEX64 = /^0x[0-9a-fA-F]{64}$/;

/**
 * Reads a burner key. Returns `undefined` when absent so read-only tooling
 * still runs — a missing key is a normal state before `pnpm wallets`, not an
 * error. A *malformed* key is an error, because it silently produces the wrong
 * address otherwise.
 */
export function getPrivateKey(slot: WalletSlot): `0x${string}` | undefined {
  const raw = process.env[`${slot}_PRIVATE_KEY`]?.trim();
  if (!raw) return undefined;
  const withPrefix = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!HEX64.test(withPrefix)) {
    throw new ConfigError(
      "BAD_PRIVATE_KEY",
      `${slot}_PRIVATE_KEY is not a 32-byte hex key (got ${raw.length} chars). ` +
        `Re-run \`pnpm wallets\` or fix .env by hand.`,
    );
  }
  return withPrefix as `0x${string}`;
}

/** Faucet + explorer links, surfaced in every actionable error message. */
export const LINKS = {
  faucet: "https://testnet.somnia.network",
  explorer: "https://shannon-explorer.somnia.network",
  docs: "https://docs.dreamdex.io/developers/event-contracts",
  telegram: "https://t.me/+XHq0F0JXMyhmMzM0",
} as const;

export const explorerTx = (hash: string): string => `${LINKS.explorer}/tx/${hash}`;
export const explorerAddr = (a: string): string => `${LINKS.explorer}/address/${a}`;
