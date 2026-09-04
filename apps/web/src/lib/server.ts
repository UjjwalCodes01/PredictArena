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
import { privateKeyToAccount } from "viem/accounts";

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

/**
 * Bound an upstream call so it cannot outlive the request.
 *
 * Serverless functions are killed at a hard wall time. An upstream that hangs
 * past it takes the whole function with it, and the caller gets a bare 504 —
 * no error code, no action, nothing the UI can switch on. Measured in
 * production: a cold `/api/claimable` took 75 seconds, which is past the
 * function limit on most plans.
 *
 * A deadline turns that into an ordinary, handled failure. The route decides
 * what a miss means: optional data falls back to empty, essential data becomes
 * a 503 with a code the UI already renders.
 *
 * Note this does not CANCEL the upstream work — these SDK calls take no signal.
 * It stops us waiting on it, which is the part that matters for the response.
 */
export async function withDeadline<T>(
  label: string,
  ms: number,
  work: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The AI forecaster's signer, and its address.
 *
 * A SEPARATE client from `serverDex()`, because this one holds a private key
 * and that key must never be attached to the client every other route uses.
 * A read path that cannot sign cannot accidentally place an order.
 *
 * Returns null when the forecaster is not configured, which is a supported
 * state: the site runs without it and says so.
 */
/**
 * Read the forecaster's key, tolerating how it arrives.
 *
 * A dashboard textarea is not a config file: it leaves trailing newlines, it
 * picks up a stray space, and people paste raw hex without the `0x`. A strict
 * anchored match on all of that returns null, which this code treats as "no
 * forecaster configured" — so a one-character paste artifact silently turns the
 * feature off and reports nothing. That happened in production.
 *
 * So: normalise what can be normalised, and when a key is present but genuinely
 * unusable, SAY SO rather than degrading into silence.
 */
function readAiKey(): `0x${string}` | null {
  const raw = process.env["AI_PRIVATE_KEY"];
  if (!raw || raw.trim() === "") return null;

  // Strip whitespace and quotes a dashboard or shell may have added.
  let key = raw.trim().replace(/^["']|["']$/g, "");
  if (!key.startsWith("0x") && /^[0-9a-fA-F]{64}$/.test(key)) key = `0x${key}`;

  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    console.error(
      `[ai] AI_PRIVATE_KEY is set but is not a 32-byte hex key ` +
        `(got ${key.length} chars${key.startsWith("0x") ? "" : ", no 0x prefix"}). ` +
        `The forecaster is disabled. Paste the private key, not an address.`,
    );
    return null;
  }
  return key as `0x${string}`;
}

let aiSingleton: { dex: DexClient; wallet: `0x${string}` } | null = null;

export function aiDex(): { dex: DexClient; wallet: `0x${string}` } | null {
  if (aiSingleton) return aiSingleton;

  const key = readAiKey();
  if (!key) return null;

  const account = privateKeyToAccount(key);
  aiSingleton = {
    dex: createDexClient({
      indexerUrl: process.env["INDEXER_URL"] ?? "https://dev.smk.somnia.host/v1/graphql",
      rpcHttpUrl: process.env["RPC_HTTP_URL"] ?? "https://dream-rpc.somnia.network",
      rpcWsUrl: process.env["RPC_WS_URL"] ?? "wss://dream-rpc.somnia.network/ws",
      privateKey: key,
    }),
    wallet: account.address,
  };
  return aiSingleton;
}

/**
 * The forecaster's address without constructing a signer.
 *
 * Read paths need it to look up its standing and its log; they have no reason
 * to hold a key to do that.
 */
export function aiWallet(): `0x${string}` | null {
  const key = readAiKey();
  if (!key) return null;
  return privateKeyToAccount(key).address;
}
