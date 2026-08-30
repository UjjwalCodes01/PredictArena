"use client";

/**
 * Wallet configuration.
 *
 * Somnia Shannon only. The chain object comes from `@predictarena/dex` so the
 * app cannot drift from the package that actually signs -- there is no second
 * copy of the chain id to get wrong.
 */
import { http, createConfig, createStorage, cookieStorage } from "wagmi";
import { injected } from "wagmi/connectors";
import { SHANNON, TESTNET_CHAIN_ID } from "@predictarena/dex";

export const RPC_URL = process.env["NEXT_PUBLIC_RPC_HTTP_URL"] ?? "https://dream-rpc.somnia.network";

export const wagmiConfig = createConfig({
  chains: [SHANNON],
  connectors: [injected()],
  // SSR-safe: without this the server render and the first client render
  // disagree about connection state and React throws a hydration error.
  ssr: true,
  storage: createStorage({ storage: cookieStorage }),
  transports: {
    [SHANNON.id]: http(RPC_URL),
  },
});

export { SHANNON, TESTNET_CHAIN_ID };

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
