/**
 * "Never write mainnet chain id, RPC, or API into code, env samples, or docs"
 * \u2014 CLAUDE.md hard rule 1.
 *
 * Comment-aware on purpose. The rule is about CONFIGURATION, not about the word
 * appearing in prose: `.env.example` explains which hosts are rejected and why,
 * and `config.ts` has to name them to refuse them. A check that cannot tell a
 * warning from a setting gets muted, and then it protects nothing.
 *
 * Run by `pnpm lint`, so CI fails on a regression.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", "artifacts", "coverage"]);

/** The guard itself must name these in order to reject them. */
const ALLOWED_FILES = [
  "packages/dex/src/config.ts",
  "packages/dex/src/__tests__/safety.test.ts",
  "scripts/lint-no-mainnet.ts",
];

const MAINNET_HOSTS = [
  "api.infra.mainnet.somnia.network",
  "prd.smk.somnia.host",
  "api.dreamdex.io",
];

/** Mainnet chain id as an actual value, not as part of 50312. */
const MAINNET_CHAIN_ID = /(?<![\d.])5031(?![\d])/;

interface Finding { file: string; line: number; text: string; why: string }

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|mjs|json|ya?ml|env\.example)$/.test(entry) || entry === ".env.example") out.push(full);
  }
  return out;
}

/** Strips comments so prose about mainnet does not read as configuration. */
function codeOnly(line: string, ext: string): string {
  const trimmed = line.trim();
  if (ext === ".example" || ext === ".yml" || ext === ".yaml") {
    return trimmed.startsWith("#") ? "" : line;
  }
  if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) return "";
  // The lookbehind matters: "https://host" contains "//", and stripping it as a
  // comment silently truncated the URL and hid the very thing we look for.
  return line.replace(/(?<!:)\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
}

function main(): void {
  const files = walk(ROOT).filter((f) => !ALLOWED_FILES.some((a) => f.endsWith(a)));
  const findings: Finding[] = [];

  for (const file of files) {
    const ext = file.endsWith(".env.example") ? ".example" : file.slice(file.lastIndexOf("."));
    let inBlock = false;
    readFileSync(file, "utf8").split("\n").forEach((raw, i) => {
      const t = raw.trim();
      if (inBlock) { if (t.includes("*/")) inBlock = false; return; }
      if (t.startsWith("/*") && !t.includes("*/")) { inBlock = true; return; }

      const code = codeOnly(raw, ext);
      if (code.trim() === "") return;

      const host = MAINNET_HOSTS.find((h) => code.toLowerCase().includes(h));
      if (host) {
        findings.push({ file, line: i + 1, text: t, why: `mainnet host "${host}"` });
        return;
      }
      // Only flag a bare 5031 where it is being used as a chain id.
      if (MAINNET_CHAIN_ID.test(code) && /chain|network|id/i.test(code)) {
        findings.push({ file, line: i + 1, text: t, why: "mainnet chain id 5031" });
      }
    });
  }

  if (findings.length === 0) {
    console.log(`no-mainnet: \u2714 ${files.length} file(s) clean`);
    return;
  }
  console.error(`no-mainnet: \u2718 ${findings.length} finding(s)\n`);
  for (const f of findings) {
    console.error(`  ${relative(ROOT, f.file)}:${f.line}  ${f.why}`);
    console.error(`    ${f.text.slice(0, 100)}`);
  }
  console.error(`\n  This project is testnet-only (CLAUDE.md hard rule 1).`);
  process.exit(1);
}

main();
