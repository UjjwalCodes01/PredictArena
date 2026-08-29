/**
 * Env loading for the CLI tools.
 *
 * `packages/dex` deliberately takes explicit config rather than reading
 * `process.env` — it has to run in a browser. This module is the Node-side
 * adapter: it reads `.env`, validates it, and hands the package a `DexConfig`.
 */
import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  createDexClient, DexError, TESTNET_CHAIN_ID, LINKS,
  type DexClient, type DexConfig,
} from "@predictarena/dex";
import { red, yellow } from "./log.js";

export const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
export const ENV_PATH = resolve(REPO_ROOT, ".env");

loadDotenv({ path: ENV_PATH, quiet: true });

export { LINKS };
export const envFileExists = (): boolean => existsSync(ENV_PATH);

function str(key: string, fallback: string): string {
  return process.env[key]?.trim() || fallback;
}

function num(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new DexError("UNKNOWN", `${key}="${raw}" is not a number.`);
  return n;
}

/** Wallet slots. DEV trades; SEED1..3 populate the demo league. */
export const WALLET_SLOTS = ["DEV", "SEED1", "SEED2", "SEED3"] as const;
export type WalletSlot = (typeof WALLET_SLOTS)[number];

const HEX64 = /^0x[0-9a-fA-F]{64}$/;

/**
 * Reads a burner key. `undefined` when absent, so read-only tooling still runs
 * before any wallet exists — but a MALFORMED key throws, because it would
 * otherwise silently derive the wrong address.
 */
export function getPrivateKey(slot: WalletSlot): `0x${string}` | undefined {
  const raw = process.env[`${slot}_PRIVATE_KEY`]?.trim();
  if (!raw) return undefined;
  const prefixed = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!HEX64.test(prefixed)) {
    throw new DexError("UNKNOWN", `${slot}_PRIVATE_KEY is not a 32-byte hex key (got ${raw.length} chars).`, {
      action: "Re-run `pnpm wallets --force`, or fix .env by hand.",
    });
  }
  return prefixed as `0x${string}`;
}

export interface AppEnv {
  readonly dex: DexConfig;
  readonly targetAsset: string;
  readonly targetIntervalSec: number;
  readonly stakeWhole: number;
  readonly venueId: string | undefined;
}

export function loadEnv(opts: { slot?: WalletSlot } = {}): AppEnv {
  const privateKey = opts.slot ? getPrivateKey(opts.slot) : undefined;
  return {
    dex: {
      indexerUrl: str("INDEXER_URL", "https://dev.smk.somnia.host/v1/graphql"),
      rpcHttpUrl: str("RPC_HTTP_URL", "https://dream-rpc.somnia.network"),
      rpcWsUrl: str("RPC_WS_URL", "wss://dream-rpc.somnia.network/ws"),
      chainId: num("CHAIN_ID", TESTNET_CHAIN_ID),
      ...(privateKey ? { privateKey } : {}),
    },
    targetAsset: str("TARGET_ASSET", "BTC").toUpperCase(),
    targetIntervalSec: num("TARGET_INTERVAL_SEC", 300),
    stakeWhole: num("STAKE_TUSDC", 1),
    venueId: process.env["VENUE_ID"]?.trim() || undefined,
  };
}

/**
 * Build the client, or exit with an actionable message rather than a stack
 * trace. A config error is an operator mistake, not a crash.
 */
export function createClientOrExit(opts: { slot?: WalletSlot } = {}): { client: DexClient; env: AppEnv } {
  try {
    const env = loadEnv(opts);
    return { client: createDexClient(env.dex), env };
  } catch (e) {
    const code = e instanceof DexError ? e.code : "UNKNOWN";
    const action = e instanceof DexError ? e.action : undefined;
    console.error(`\n${red(`\u2718 Cannot start: ${code}`)}`);
    console.error(`  ${e instanceof Error ? e.message : String(e)}`);
    console.error(`  ${yellow("\u2192")} ${action ?? "Fix .env (see .env.example) and re-run."}\n`);
    process.exit(1);
  }
}
