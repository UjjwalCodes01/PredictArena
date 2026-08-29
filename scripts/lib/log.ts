/**
 * Console reporting for the Phase 0 scripts.
 *
 * Every failure prints a machine `code` and a human next action — the same
 * contract `packages/dex` will expose as `DexError` (CLAUDE.md "Error handling
 * pattern"). A bare "Something went wrong" is a bug here too.
 */
const useColor = process.stdout.isTTY && !process.env["NO_COLOR"];
const c = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const dim = c("2");
export const bold = c("1");
export const red = c("31");
export const green = c("32");
export const yellow = c("33");
export const blue = c("36");

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface CheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  /** One line of detail — the measured value, not a restatement of the name. */
  readonly detail: string;
  /** What the operator should do about it. Required for warn/fail. */
  readonly action?: string;
  /** Machine code, so the gate script can branch without string matching. */
  readonly code?: string;
}

const GLYPH: Record<CheckStatus, string> = {
  pass: green("✔"),
  warn: yellow("!"),
  fail: red("✘"),
  skip: dim("–"),
};

export function heading(title: string): void {
  console.log(`\n${bold(title)}\n${dim("─".repeat(Math.max(title.length, 56)))}`);
}

export function report(r: CheckResult): void {
  console.log(`${GLYPH[r.status]} ${r.name}`);
  if (r.detail) console.log(`    ${dim(r.detail)}`);
  if (r.action) console.log(`    ${yellow("→")} ${r.action}`);
}

export function info(msg: string): void {
  console.log(`  ${dim(msg)}`);
}

export function kv(key: string, value: string): void {
  console.log(`    ${dim(key.padEnd(22))}${value}`);
}

/** Prints the tally and returns the exit code the script should use. */
export function summarise(results: readonly CheckResult[], title = "Summary"): number {
  const n = (s: CheckStatus) => results.filter((r) => r.status === s).length;
  const failed = n("fail");
  heading(title);
  console.log(
    `  ${green(`${n("pass")} passed`)}   ${yellow(`${n("warn")} warning`)}   ` +
      `${red(`${failed} failed`)}   ${dim(`${n("skip")} skipped`)}`,
  );
  if (failed > 0) {
    console.log(`\n  ${red("Blocking issues:")}`);
    for (const r of results.filter((x) => x.status === "fail")) {
      console.log(`   ${red("✘")} ${r.name}${r.code ? dim(` [${r.code}]`) : ""}`);
      if (r.action) console.log(`     ${yellow("→")} ${r.action}`);
    }
  }
  return failed > 0 ? 1 : 0;
}

/** Formats an unknown thrown value without leaking a stack trace at users. */
export function describeError(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    return code ? `${e.message} [${String(code)}]` : e.message;
  }
  return String(e);
}

/**
 * Wraps a check so one failing probe never aborts the whole run — the point of
 * a doctor script is to report everything wrong in one pass, not the first
 * thing wrong.
 */
export async function check(
  name: string,
  fn: () => Promise<Omit<CheckResult, "name">>,
): Promise<CheckResult> {
  try {
    return { name, ...(await fn()) };
  } catch (e) {
    return {
      name,
      status: "fail",
      detail: describeError(e),
      code: (e as { code?: string })?.code ?? "UNEXPECTED",
      action: "Unexpected error — see the detail above.",
    };
  }
}
