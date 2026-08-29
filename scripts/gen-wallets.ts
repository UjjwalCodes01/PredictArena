/**
 * `pnpm wallets` — generate the four burner wallets Phase 0 needs.
 *
 * DEV places the single recon order; SEED1..3 populate the demo league later.
 *
 * Safety properties, in order of how badly they'd hurt if missing:
 *  1. Refuses to run unless `.gitignore` actually excludes `.env` — key
 *     material must never exist on disk before the ignore rule does.
 *  2. Never overwrites an existing key without `--force`. Those wallets get
 *     funded by hand from a rate-limited faucet; clobbering them silently
 *     would strand the funds and cost a faucet cycle we may not get back.
 *  3. Writes private keys to `.env` only, never to stdout — a key printed to a
 *     terminal ends up in scrollback, tmux buffers and CI logs.
 */
import { existsSync, readFileSync, writeFileSync, chmodSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ENV_PATH, REPO_ROOT, WALLET_SLOTS, LINKS, type WalletSlot } from "./lib/env.js";
import { bold, dim, green, yellow, red, heading, kv } from "./lib/log.js";

const force = process.argv.includes("--force");

function assertGitignoreProtectsEnv(): void {
  const gitignorePath = resolve(REPO_ROOT, ".gitignore");
  if (!existsSync(gitignorePath)) {
    console.error(red("✘ No .gitignore in the repo root."));
    console.error(`  ${yellow("→")} Create it with a \`.env\` line before generating any key.`);
    process.exit(1);
  }
  const rules = readFileSync(gitignorePath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (!rules.includes(".env")) {
    console.error(red("✘ .gitignore does not contain a bare `.env` rule."));
    console.error(`  ${yellow("→")} Add a bare .env line to .gitignore before generating any key (CLAUDE.md rule 2).`);
    process.exit(1);
  }
}

/** Rewrites one KEY=value line in place, preserving comments and ordering. */
function setEnvValue(content: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  return pattern.test(content) ? content.replace(pattern, line) : `${content.trimEnd()}\n${line}\n`;
}

function readEnvValue(content: string, key: string): string {
  return new RegExp(`^${key}=(.*)$`, "m").exec(content)?.[1]?.trim() ?? "";
}

function main(): void {
  assertGitignoreProtectsEnv();

  if (!existsSync(ENV_PATH)) {
    const sample = resolve(REPO_ROOT, ".env.example");
    if (!existsSync(sample)) {
      console.error(red("✘ Neither .env nor .env.example exists."));
      process.exit(1);
    }
    copyFileSync(sample, ENV_PATH);
    console.log(`${green("✔")} Created .env from .env.example`);
  }

  let content = readFileSync(ENV_PATH, "utf8");

  const existing = WALLET_SLOTS.filter((s) => readEnvValue(content, `${s}_PRIVATE_KEY`) !== "");
  if (existing.length > 0 && !force) {
    heading("Wallets already exist");
    console.log(`  ${yellow("!")} These slots already hold a key: ${bold(existing.join(", "))}`);
    console.log(`  ${dim("They may already be funded. Refusing to overwrite them.")}\n`);
    for (const slot of WALLET_SLOTS) {
      const key = readEnvValue(content, `${slot}_PRIVATE_KEY`);
      if (!key) continue;
      try {
        kv(slot, privateKeyToAccount(key as `0x${string}`).address);
      } catch {
        kv(slot, red("malformed key — fix .env by hand"));
      }
    }
    console.log(
      `\n  ${yellow("→")} To replace them anyway (funds will be stranded): ` +
        `${bold("pnpm wallets --force")}`,
    );
    console.log(`  ${yellow("→")} To keep them and continue Phase 0: ${bold("pnpm doctor")}\n`);
    return;
  }

  const created: Array<{ slot: WalletSlot; address: string }> = [];
  for (const slot of WALLET_SLOTS) {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    content = setEnvValue(content, `${slot}_PRIVATE_KEY`, privateKey);
    created.push({ slot, address: account.address });
  }

  writeFileSync(ENV_PATH, content, { mode: 0o600 });
  chmodSync(ENV_PATH, 0o600);

  heading("Generated 4 fresh burner wallets");
  console.log(`  ${dim("Keys were written to .env (mode 600) and are NOT printed here.")}\n`);
  for (const { slot, address } of created) kv(slot, address);

  heading("Next: fund them");
  console.log(`  These are empty. Phase 0 needs the DEV wallet funded with both:\n`);
  console.log(`    ${bold("STT")}    native gas token`);
  console.log(`    ${bold("tUSDC")}  the collateral Event Contracts settle in ${dim("(6 decimals)")}\n`);
  console.log(`  1. Open ${bold(LINKS.faucet)}`);
  console.log(`  2. Request STT for the ${bold("DEV")} address above`);
  console.log(`  3. Request/mint tUSDC for the same address`);
  console.log(`  4. Run ${bold("pnpm doctor")} — it verifies both balances and the whole stack\n`);
  console.log(
    `  ${dim("SEED1..3 only matter from Phase 5 (demo league seeding); fund them when you get there.")}\n`,
  );
}

main();
