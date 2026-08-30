import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      // `server-only` is a Next build-time guard: importing it from a client
      // component is a build error. Vitest has no such notion, so it is stubbed
      // here. The guard still applies where it matters -- in `next build`.
      "server-only": resolve(__dirname, "test/stubs/server-only.ts"),
      "@": resolve(__dirname, "apps/web/src"),
    },
  },
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "apps/web/src/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    reporters: ["default"],
  },
});
