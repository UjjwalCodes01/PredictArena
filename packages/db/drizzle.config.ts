import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit config. `generate` writes SQL from the schema and needs no
 * connection; `migrate` (src/migrate.ts) applies it and does.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env["DATABASE_URL"] ?? "",
  },
  strict: true,
  verbose: true,
});
