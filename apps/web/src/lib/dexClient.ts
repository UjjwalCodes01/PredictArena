"use client";

/**
 * The browser's DexClient, created once.
 *
 * `createDexClient` is not cheap: it builds a SomniaMarkets instance, a viem
 * public client, a request queue and a clock, and it exposes `close()` because
 * it can hold live connections.
 *
 * Every hook here used to construct its own and never close it. `useBalances`
 * alone did that every twenty seconds, so a tab left open accumulated one
 * abandoned client per poll — the page got progressively heavier until it
 * stopped responding, which is exactly what a user sees as "it froze".
 *
 * Two clients, both reused:
 *
 *  - a READ client with no wallet, for balances and quotes;
 *  - a WALLET client, rebuilt only when the connected account actually changes.
 */
import type { DexClient } from "@predictarena/dex";
import { RPC_URL } from "./wagmi";

/**
 * The venue SDK is loaded ON DEMAND, not at import time.
 *
 * Statically importing `createDexClient` put ~535KB of exchange client and
 * elliptic-curve code into the bundle EVERY page downloads — including the
 * leaderboard, which never constructs a client. Lighthouse measured 770ms of
 * blocking time and scored performance 76.
 *
 * A dynamic import moves it to its own chunk, fetched the first time someone
 * actually touches a wallet. The cost is that these accessors are async; the
 * benefit is that reading a leaderboard no longer pays for a trading engine.
 */
async function loadFactory(): Promise<typeof import("@predictarena/dex").createDexClient> {
  const mod = await import("@predictarena/dex");
  return mod.createDexClient;
}

const INDEXER_URL =
  process.env["NEXT_PUBLIC_INDEXER_URL"] ?? "https://dev.smk.somnia.host/v1/graphql";

let readClient: DexClient | null = null;

/** Read-only client. No wallet, so it is safe to share across every caller. */
export async function getReadClient(): Promise<DexClient> {
  if (!readClient) {
    const createDexClient = await loadFactory();
    readClient ??= createDexClient({ indexerUrl: INDEXER_URL, rpcHttpUrl: RPC_URL });
  }
  return readClient;
}

let walletClientCache: { account: string; client: DexClient } | null = null;

/**
 * Signing client for one account.
 *
 * Rebuilt only when the account changes — and the previous one is closed first,
 * so switching wallets does not leave the old client's connections open.
 */
export async function getWalletDexClient(
  walletClient: unknown,
  account: `0x${string}`,
): Promise<DexClient> {
  const key = account.toLowerCase();
  if (walletClientCache?.account === key) return walletClientCache.client;

  if (walletClientCache) {
    try {
      walletClientCache.client.close();
    } catch {
      /* nothing live to stop */
    }
  }

  const createDexClient = await loadFactory();
  const client = createDexClient({
    indexerUrl: INDEXER_URL,
    rpcHttpUrl: RPC_URL,
    walletClient: walletClient as never,
    account,
  });
  walletClientCache = { account: key, client };
  return client;
}

/** Release the signing client. Called when the wallet disconnects. */
export function releaseWalletDexClient(): void {
  if (!walletClientCache) return;
  try {
    walletClientCache.client.close();
  } catch {
    /* nothing live to stop */
  }
  walletClientCache = null;
}
