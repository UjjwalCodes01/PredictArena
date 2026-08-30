import "server-only";

/**
 * Server-side clients.
 *
 * Both live here so their secrets never reach the browser: `DATABASE_URL` is
 * read only in this module, and every page or route that needs data goes
 * through it. The browser gets a `DexClient` of its own for signing, which
 * needs no secret at all.
 */
import { createDexClient, assertLiveNetwork, type DexClient } from "@predictarena/dex";
import { createDb, type Database } from "@predictarena/db";

let dexSingleton: DexClient | null = null;
let verified: Promise<unknown> | null = null;
let dbSingleton: Database | null = null;

export function serverDex(): DexClient {
  dexSingleton ??= createDexClient({
    indexerUrl: process.env["INDEXER_URL"] ?? "https://dev.smk.somnia.host/v1/graphql",
    rpcHttpUrl: process.env["RPC_HTTP_URL"] ?? "https://dream-rpc.somnia.network",
    rpcWsUrl: process.env["RPC_WS_URL"] ?? "wss://dream-rpc.somnia.network/ws",
  });
  // Assert chain and collateral identity once per process, not per request.
  verified ??= assertLiveNetwork(dexSingleton).catch(() => {
    verified = null; // let the next request retry rather than caching a failure
  });
  return dexSingleton;
}

export function serverDb(): Database {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is not set on the server.");
  dbSingleton ??= createDb(url);
  return dbSingleton;
}
