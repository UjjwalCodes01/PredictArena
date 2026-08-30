"use client";

/**
 * What the connected wallet actually holds.
 *
 * Read BEFORE a stake is chosen, not after. `preflightCall` throws on a
 * shortfall, which is the right behaviour for gating a signature and the wrong
 * one for telling someone what they have -- an exception is not a balance.
 *
 * Read-only, so it goes through a public client with no wallet attached.
 */
import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { createDexClient, getBalances, type Balances } from "@predictarena/dex";
import { RPC_URL } from "@/lib/wagmi";

const INDEXER_URL =
  process.env["NEXT_PUBLIC_INDEXER_URL"] ?? "https://dev.smk.somnia.host/v1/graphql";

export function useBalances(pool?: `0x${string}`) {
  const { address, isConnected } = useAccount();

  return useQuery<Balances>({
    queryKey: ["balances", address, pool ?? "none"],
    queryFn: async () => {
      const dex = createDexClient({ indexerUrl: INDEXER_URL, rpcHttpUrl: RPC_URL });
      return getBalances(dex, address as `0x${string}`, pool);
    },
    enabled: Boolean(address) && isConnected,
    // Balances move when the user funds a wallet or places a call. Often enough
    // that a stale figure misleads; rare enough that polling hard is waste.
    refetchInterval: 20_000,
    staleTime: 10_000,
  });
}
