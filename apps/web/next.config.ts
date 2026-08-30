import type { NextConfig } from "next";
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

/**
 * The workspace keeps ONE .env at the repo root -- the indexer, the CLI tools
 * and this app all read the same file. Next only looks inside its own
 * directory, so load the root one here rather than keeping a second copy of
 * secrets in sync by hand.
 */
loadEnv({ path: resolve(process.cwd(), "..", "..", ".env"), quiet: true });

const config: NextConfig = {
  reactStrictMode: true,
  // The workspace packages ship TypeScript source, not a build step.
  transpilePackages: ["@predictarena/dex", "@predictarena/db", "@predictarena/indexer"],
  typedRoutes: true,
  images: { formats: ["image/avif", "image/webp"] },
  // Next 16 writes its own AGENTS.md / CLAUDE.md into the app directory. This
  // repo already has both at the root as the project spec, and a second pair
  // nested here would shadow them for anyone working in apps/web.
  agentRules: false,
  // Only non-secret values are exposed to the browser. DATABASE_URL stays
  // server-side and is never referenced from a client component.
  env: {
    NEXT_PUBLIC_RPC_HTTP_URL: process.env["RPC_HTTP_URL"] ?? "https://dream-rpc.somnia.network",
    NEXT_PUBLIC_INDEXER_URL: process.env["INDEXER_URL"] ?? "https://dev.smk.somnia.host/v1/graphql",
    // Public by design: it identifies the app to WalletConnect, it authorises
    // nothing. Absent, the connector is not offered at all.
    NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: process.env["WALLETCONNECT_PROJECT_ID"] ?? "",
    // Vercel injects VERCEL_URL per deployment; metadata uses it so preview and
    // production each describe themselves rather than sharing one hard-coded host.
    NEXT_PUBLIC_SITE_URL: process.env["SITE_URL"] ?? process.env["VERCEL_URL"] ?? "",
  },
};

export default config;
