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
import type { Balances } from "@predictarena/dex";
import { getReadClient } from "@/lib/dexClient";


export function useBalances(pool?: `0x${string}`) {
  const { address, isConnected } = useAccount();

  return useQuery<Balances>({
    queryKey: ["balances", address, pool ?? "none"],
    queryFn: async () => {
      // Shared read client: constructing one per poll leaked a client every
      // twenty seconds and eventually froze the tab.
      const [{ getBalances }, dex] = await Promise.all([
        import("@predictarena/dex"),
        getReadClient(),
      ]);
      return getBalances(dex, address as `0x${string}`, pool);
    },
    enabled: Boolean(address) && isConnected,
    // Balances move when the user funds a wallet or places a call. Often enough
    // that a stale figure misleads; rare enough that polling hard is waste.
    refetchInterval: 20_000,
    staleTime: 10_000,
  });
}
