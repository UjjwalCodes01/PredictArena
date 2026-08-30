import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Both the dex package and the repo-level scripts.
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "scripts/**/*.test.ts"],
    reporters: ["default"],
  },
});
