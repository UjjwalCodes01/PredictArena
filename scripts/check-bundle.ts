/**
 * `pnpm check:bundle` -- prove no secret reached the browser.
 *
 * Run AFTER a build. Scans the client bundle for anything shaped like a
 * credential: a Postgres URL, a private key, or the live DATABASE_URL's own
 * host and password when a .env is present.
 *
 * This exists because a leak here is silent. Nothing warns you that a server
 * value ended up in a chunk that every visitor downloads -- you have to look.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const CLIENT_DIR = resolve(ROOT, "apps", "web", ".next", "static");

/**
 * Shapes that are never legitimate in a browser bundle.
 *
 * Deliberately NOT a bare 64-hex "private key" pattern. A bundle containing
 * viem is full of 64-hex constants -- the secp256k1 field prime and curve
 * order, the ERC-1967 implementation slot -- and flagging those trains people
 * to ignore the check, which is worse than not having one. Real key material
 * is caught by the exact-value scan below instead, which has no false
 * positives because it compares against the actual .env.
 */
const PATTERNS: Array<[string, RegExp]> = [
  ["postgres connection string", /postgres(ql)?:\/\/[^\s"']*:[^\s"']*@[^\s"']{4,}/],
  ["credentialled database host", /:[^\s"'@/]{8,}@[a-z0-9-]+\.[a-z0-9.-]*(neon\.tech|rds\.amazonaws|supabase)/],
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (st.size < 20_000_000) out.push(full);
  }
  return out;
}

function envSecrets(): Array<[string, string]> {
  const envPath = resolve(ROOT, ".env");
  if (!existsSync(envPath)) return [];
  const out: Array<[string, string]> = [];
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    if (line.startsWith("#") || !line.includes("=")) continue;
    const [k, ...rest] = line.split("=");
    const v = rest.join("=").trim();
    if (!k || v.length < 8) continue;
    if (/DATABASE_URL|PRIVATE_KEY|SECRET|PASSWORD/i.test(k)) out.push([k.trim(), v]);
  }
  return out;
}

function main(): void {
  if (!existsSync(CLIENT_DIR)) {
    console.error(`check:bundle: no client build at ${CLIENT_DIR}`);
    console.error("  Run `pnpm build` first.");
    process.exit(1);
  }

  const files = walk(CLIENT_DIR);
  const findings: string[] = [];

  for (const file of files) {
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { continue; }

    for (const [label, re] of PATTERNS) {
      if (re.test(text)) findings.push(`${label} in ${file.replace(ROOT, "")}`);
    }
    // Exact values from the local .env, if there is one.
    for (const [key, value] of envSecrets()) {
      if (text.includes(value)) findings.push(`${key} VALUE in ${file.replace(ROOT, "")}`);
    }
  }

  if (findings.length === 0) {
    console.log(`check:bundle: clean -- scanned ${files.length} client file(s), no secrets found`);
    return;
  }

  console.error(`check:bundle: ${findings.length} FINDING(S)\n`);
  // The finding is named, never the value: printing it would leak it again.
  for (const f of new Set(findings)) console.error(`  ${f}`);
  console.error("\n  A server value reached the browser bundle. Move it behind a server module.");
  process.exit(1);
}

main();
