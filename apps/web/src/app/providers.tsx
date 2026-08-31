"use client";

import { WagmiProvider, useAccount } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { wagmiConfig } from "@/lib/wagmi";
import { clearPending } from "@/lib/pending";
import { releaseWalletDexClient } from "@/lib/dexClient";
import { ErrorReporter } from "@/components/ErrorReporter";
import { KeepFresh } from "@/components/KeepFresh";

export function Providers({ children }: { children: ReactNode }) {
  // Created once per mount, not per render, so the cache is not thrown away.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Live market data goes stale fast; a cached window is a window the
            // user may no longer be able to trade.
            staleTime: 3_000,
            refetchOnWindowFocus: true,
            retry: 1,
          },
        },
      }),
  );

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <SessionReset />
        <ErrorReporter />
        <KeepFresh />
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}

/**
 * Clear browser-held session state when the account changes or disconnects.
 *
 * wagmi resets its own state on `accountsChanged`, but our optimistic pending
 * rows are ours to clean up -- leaving them would show one account's calls
 * under another's name, which is worse than showing nothing.
 */
function SessionReset() {
  const { address } = useAccount();
  useEffect(() => {
    clearPending();
    // The signing client is bound to an account; drop it so the next account
    // does not inherit the previous one's connections.
    releaseWalletDexClient();
  }, [address]);
  return null;
}
