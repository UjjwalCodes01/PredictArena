"use client";

/**
 * Wallet configuration.
 *
 * Somnia Shannon only. The chain object comes from `@predictarena/dex` so the
 * app cannot drift from the package that actually signs -- there is no second
 * copy of the chain id to get wrong.
 */
import { http, createConfig, createStorage, cookieStorage } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";
import { SHANNON, TESTNET_CHAIN_ID } from "@predictarena/dex";

export const RPC_URL = process.env["NEXT_PUBLIC_RPC_HTTP_URL"] ?? "https://dream-rpc.somnia.network";

/**
 * WalletConnect needs a project id from WalletConnect Cloud. It is public --
 * it identifies the app, it does not authorise anything -- so it ships as a
 * NEXT_PUBLIC value.
 *
 * Absent, the connector is simply not offered. Registering it without an id
 * throws at module load and would take the whole app down rather than
 * degrading to injected-only, which is a working experience for most people.
 */
const WC_PROJECT_ID = process.env["NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID"];

const connectors = [
  injected(),
  ...(WC_PROJECT_ID
    ? [
        walletConnect({
          projectId: WC_PROJECT_ID,
          showQrModal: true,
          metadata: {
            name: "Prediction Leagues",
            description: "A weekly league on DreamDEX Event Contracts.",
            url: "https://prediction-leagues.vercel.app",
            icons: [],
          },
        }),
      ]
    : []),
];

export const wagmiConfig = createConfig({
  chains: [SHANNON],
  connectors,
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
