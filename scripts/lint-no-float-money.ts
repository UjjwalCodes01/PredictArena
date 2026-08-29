/**
 * "No float appears in any file that imports the dex package" — AGENTS.md §7.
 *
 * ESLint bans `parseFloat` outright; this catches the subtler shape: a decimal
 * literal or a float-producing call sitting in the same expression as something
 * that is obviously an amount. It is deliberately narrow — a check that cries
 * wolf gets disabled, and then it protects nothing.
 *
 * Run by `pnpm lint`, so CI fails on a regression.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", "artifacts", "coverage"]);

/** Identifiers that mean "this is money". */
const MONEY = /\b(stake|escrow|payout|balance|collateral|allowance|amount|price|wei|tusdc|usdc|usdso|quantity|contracts|claimable|proceeds)\b/i;

/** Float-producing constructs that must not touch an amount. */
const FLOAT_CALL = /\b(parseFloat|Number\.parseFloat)\s*\(/;
const TO_FIXED = /\.toFixed\s*\(/;
/** A decimal literal, but not a version string, and not `0.5` inside a comment. */
const DECIMAL_LITERAL = /(?<![\w.])\d+\.\d+(?![\w.])/;

interface Finding {
  file: string;
  line: number;
  text: string;
  why: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** Does this file participate in money handling? */
function isMoneyFile(path: string, source: string): boolean {
  if (path.includes(`${"packages"}/dex/src`)) return true;
  return /from\s+["']@predictarena\/dex["']/.test(source);
}

function stripCommentsAndStrings(line: string): string {
  return line
    .replace(/\/\/.*$/, "")
    .replace(/\/\*.*?\*\//g, "")
    .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""');
}

function main(): void {
  const files = walk(ROOT).filter((f) => {
    try {
      return isMoneyFile(f, readFileSync(f, "utf8"));
    } catch {
      return false;
    }
  });

  const findings: Finding[] = [];

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const lines = source.split("\n");
    let inBlockComment = false;

    lines.forEach((raw, i) => {
      const trimmed = raw.trim();
      if (inBlockComment) {
        if (trimmed.includes("*/")) inBlockComment = false;
        return;
      }
      if (trimmed.startsWith("/*")) {
        if (!trimmed.includes("*/")) inBlockComment = true;
        return;
      }
      if (trimmed.startsWith("*") || trimmed.startsWith("//")) return;

      const code = stripCommentsAndStrings(raw);
      if (code.trim() === "") return;

      if (FLOAT_CALL.test(code)) {
        findings.push({ file, line: i + 1, text: trimmed, why: "parseFloat near money" });
        return;
      }
      if (MONEY.test(code) && TO_FIXED.test(code)) {
        findings.push({ file, line: i + 1, text: trimmed, why: "toFixed() on an amount" });
        return;
      }
      if (MONEY.test(code) && DECIMAL_LITERAL.test(code)) {
        findings.push({ file, line: i + 1, text: trimmed, why: "decimal literal in an expression with an amount" });
      }
    });
  }

  if (findings.length === 0) {
    console.log(`no-float-money: ✔ ${files.length} money-handling file(s) clean`);
    return;
  }

  console.error(`no-float-money: ✘ ${findings.length} finding(s)\n`);
  for (const f of findings) {
    console.error(`  ${relative(ROOT, f.file)}:${f.line}  ${f.why}`);
    console.error(`    ${f.text.slice(0, 100)}`);
  }
  console.error(`\n  Amounts are bigint end to end (CLAUDE.md hard rule 3).`);
  console.error(`  Format only at the display edge, with formatFixed/formatAmount.`);
  process.exit(1);
}

main();
