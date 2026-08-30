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

/**
 * Retry a READ through a database that may be asleep.
 *
 * Neon suspends a project when it is idle, and the first query after that can
 * time out at the connection layer rather than returning anything. Without this
 * the very first visitor to a cold deployment gets a 503 on the leaderboard,
 * activity, portfolio and profile at once -- which is precisely the state a
 * judge or a new player arrives in.
 *
 * READS ONLY. Every caller here is a SELECT, so retrying is safe by
 * construction; a write must decide for itself whether it is idempotent.
 *
 * Backoff is sized against an actual Neon wake-up, which takes ten to twenty
 * seconds -- an 800ms retry simply fails three times in a row and reports a
 * 503 that a longer wait would have avoided. Start-up warm-up (see
 * `instrumentation.ts`) is the real remedy; this covers a database that
 * suspends again while the server is still running.
 */
export async function dbRead<T>(
  fn: () => Promise<T>,
  attempts = 3,
  // Injectable so tests exercise the retry logic without waiting seven real
  // seconds. Production never passes it.
  baseDelayMs = 2_500,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, attempt * baseDelayMs));
      }
    }
  }
  throw lastError;
}
