/**
 * Market metadata, cached with a TTL.
 *
 * "Never hard-code contract addresses" (CLAUDE.md rule 5) generalises here to
 * venue ids, which move: six venues were live on Shannon during Phase 0, and the
 * id the bot kit documents as *mainnet* was among them, on testnet. So a venue
 * id is never pinned and never used as a network signal.
 */
import type { DexClient } from "./client.js";
import { TESTNET_ADDRESSES } from "./config.js";
import { asDexError, DexError } from "./errors.js";

export interface VenueInfo {
  readonly venueId: string;
  readonly operatorId: number;
}

export interface MarketsInfo {
  readonly chainId: number;
  readonly collateral: { address: `0x${string}`; symbol: string; decimals: number };
  /** Assets with live Up/Down windows, e.g. ["BTC", "ETH"]. */
  readonly assets: readonly string[];
  readonly venues: readonly VenueInfo[];
  readonly addresses: typeof TESTNET_ADDRESSES;
  /** When this snapshot was taken (chain-corrected ms). */
  readonly fetchedAtMs: number;
}

interface CacheEntry {
  value: MarketsInfo;
  expiresAtMs: number;
}

const cache = new WeakMap<DexClient, CacheEntry>();

/** Clears the cache for a client. Used by tests and after a network change. */
export function invalidateMarkets(client: DexClient): void {
  cache.delete(client);
}

/**
 * Markets + addresses + token decimals, cached.
 *
 * `force` bypasses the cache; the cached value is still returned if a refresh
 * fails, because stale metadata beats a dead app — the addresses and decimals
 * in it do not change minute to minute.
 */
export async function getMarkets(client: DexClient, opts: { force?: boolean } = {}): Promise<MarketsInfo> {
  const ttl = client.config.marketsTtlMs ?? 60_000;
  const now = Date.now();
  const cached = cache.get(client);
  if (!opts.force && cached && cached.expiresAtMs > now) return cached.value;

  try {
    const [assets, venues] = await client.queue.run(() =>
      Promise.all([
        client.exchange.client.listBinaryAssets(),
        client.exchange.client.listBinaryVenueIds(),
      ]),
    );

    if (assets.length === 0) {
      throw new DexError("NO_MARKETS", "The indexer lists no binary assets.", {
        action: `Confirm the indexer URL serves Shannon: ${client.config.indexerUrl}`,
        retryable: true,
      });
    }

    const value: MarketsInfo = {
      chainId: client.config.chainId,
      collateral: client.collateral,
      assets: [...assets].sort(),
      venues: venues.map((v) => ({ venueId: String(v.venueId), operatorId: Number(v.operatorId) })),
      addresses: TESTNET_ADDRESSES,
      fetchedAtMs: now,
    };
    cache.set(client, { value, expiresAtMs: now + ttl });
    return value;
  } catch (e) {
    if (cached) return cached.value;
    throw asDexError(e, "API_DOWN");
  }
}
