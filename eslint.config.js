// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules/**", "dist/**", ".next/**", "artifacts/**", "**/*.d.ts"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { console: "readonly", process: "readonly", setTimeout: "readonly", clearTimeout: "readonly" },
    },
    rules: {
      // Money is bigint end to end; these are the functions that quietly turn an
      // amount into a float (CLAUDE.md hard rule 3). `scripts/lint-no-float-money.ts`
      // catches them near amounts specifically; this bans the worst outright.
      "no-restricted-globals": [
        "error",
        { name: "parseFloat", message: "No floats for money. Use bigint and packages/dex money helpers." },
        { name: "parseInt", message: "Use Number() for non-money values, or BigInt() for amounts." },
      ],
      "no-restricted-properties": [
        "error",
        { object: "Number", property: "parseFloat", message: "No floats for money." },
      ],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": "off",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "prefer-const": "error",
    },
  },
);
