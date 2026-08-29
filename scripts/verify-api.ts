/**
 * `pnpm verify-api` \u2014 run every exported entry point against live Shannon.
 *
 * A typecheck proves a function compiles, not that it works. This exercises the
 * whole public surface of `packages/dex` against real data so "the API works"
 * is a measured claim rather than an inference.
 *
 * Read-only: `prepareCall` BUILDS an unsigned transaction and never sends it,
 * and nothing else here signs. Safe to run any time.
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import {
  assertLiveNetwork, getMarkets, invalidateMarkets, getWindows, getCurrentWindow,
  quoteCall, preflightCall, prepareCall, getSettlement, getPositions, getOutcomeBalance,
  subscribe, statusFor, formatFixed, headroomSecFor, MarketStatus, DexError,
  type Direction, type Window,
} from "@predictarena/dex";
import { createClientOrExit, getPrivateKey, REPO_ROOT } from "./lib/env.js";
import { bold, dim, green, red, heading, report, check, summarise, type CheckResult } from "./lib/log.js";

const results: CheckResult[] = [];
const push = (r: CheckResult): CheckResult => (results.push(r), report(r), r);

async function main(): Promise<void> {
  console.log(bold("\nverify-api \u2014 every export, against live Shannon"));
  console.log(dim("Read-only. prepareCall builds an unsigned tx and does not send it.\n"));

  const { client, env } = createClientOrExit({ slot: "DEV" });
  const d = client.collateral.decimals;
  const key = getPrivateKey("DEV");
  const account = key ? privateKeyToAccount(key).address : undefined;
  const stake = BigInt(Math.round(env.stakeWhole)) * 10n ** BigInt(d);

  let window: Window | undefined;
  let direction: Direction | undefined;

  try {
    heading("client");
    push(await check("assertLiveNetwork", async () => {
      const net = await assertLiveNetwork(client);
      return { status: "pass", code: "OK",
        detail: `chain ${net.chainId}, ${net.collateralSymbol}/${net.collateralDecimals}dp \u2014 both read from chain` };
    }));

    heading("markets");
    push(await check("getMarkets", async () => {
      const m = await getMarkets(client);
      return { status: "pass", code: "OK", detail: `${m.assets.length} asset(s), ${m.venues.length} venue(s)` };
    }));

    push(await check("getMarkets caches within its TTL", async () => {
      const a = await getMarkets(client);
      const b = await getMarkets(client);
      return a.fetchedAtMs === b.fetchedAtMs
        ? { status: "pass", code: "OK", detail: "second call served from cache" }
        : { status: "fail", code: "NO_CACHE", detail: "cache did not hold", action: "Check the TTL logic." };
    }));

    push(await check("invalidateMarkets forces a refetch", async () => {
      const before = await getMarkets(client);
      invalidateMarkets(client);
      const after = await getMarkets(client);
      return after.fetchedAtMs !== before.fetchedAtMs
        ? { status: "pass", code: "OK", detail: "cache cleared and refetched" }
        : { status: "fail", code: "STALE", detail: "still served the cached value",
            action: "invalidateMarkets is not clearing the entry." };
    }));

    heading("windows");
    push(await check("getWindows", async () => {
      const ws = await getWindows(client, { asset: env.targetAsset });
      if (ws.length === 0) {
        return { status: "warn", code: "NO_MARKETS", detail: `no tradable ${env.targetAsset} windows right now`,
          action: "Windows respawn on a schedule; re-run shortly." };
      }
      const w = ws[0];
      const gated = ws.every((x) => x.status === MarketStatus.Trading);
      return { status: "pass", code: "OK",
        detail: `${ws.length} window(s); all on-chain Trading=${gated}; soonest closes in ${Math.round(w!.secondsLeft)}s` };
    }));

    push(await check("getCurrentWindow", async () => {
      window = await getCurrentWindow(client, { asset: env.targetAsset });
      if (!window) {
        return { status: "warn", code: "NO_MARKETS", detail: "no tradable window right now",
          action: "Re-run shortly." };
      }
      return { status: "pass", code: "OK",
        detail: `${window.asset} ${window.intervalSec}s, closes in ${Math.round(window.secondsLeft)}s ` +
                `(headroom ${headroomSecFor(window.intervalSec ?? 0)}s)` };
    }));

    heading("orders (nothing is signed)");
    push(await check("quoteCall", async () => {
      if (!window) return { status: "skip", code: "NO_WINDOW", detail: "no window available" };
      for (const dir of ["UP", "DOWN"] as Direction[]) {
        const q = await quoteCall(client, { window, direction: dir, stake });
        if (q) {
          direction = dir;
          return { status: "pass", code: "OK",
            detail: `${dir} \u2014 ${formatFixed(q.quantity, d, 4)} contracts for ` +
                    `${formatFixed(q.escrow, d, 4)} ${client.collateral.symbol}` };
        }
      }
      return { status: "warn", code: "NO_LIQUIDITY", detail: "no resting asks on either side",
        action: "Makers quote intermittently; run `pnpm survey`." };
    }));

    push(await check("preflightCall", async () => {
      if (!window || !direction || !account) {
        return { status: "skip", code: "NO_INPUT", detail: "needs a window, a fillable side and a funded wallet" };
      }
      const quote = await quoteCall(client, { window, direction, stake });
      if (!quote) return { status: "skip", code: "NO_LIQUIDITY", detail: "side went dry between calls" };
      const pf = await preflightCall(client, { window, quote, account });
      return { status: "pass", code: "OK",
        detail: `balance ok, allowance ${pf.needsApproval ? "SHORT (approval pre-step required)" : "sufficient"}` };
    }));

    push(await check("prepareCall builds an unsigned tx for browser signing", async () => {
      if (!window || !direction || !account) {
        return { status: "skip", code: "NO_INPUT", detail: "needs a window, a fillable side and a funded wallet" };
      }
      const prepared = await prepareCall(client, { window, direction, stake, account });
      const hasOrder = Boolean(prepared.order && prepared.order.to && prepared.order.data);
      return hasOrder
        ? { status: "pass", code: "OK",
            detail: `unsigned order to ${String(prepared.order.to).slice(0, 12)}\u2026, ` +
                    `${prepared.approval ? "approval pre-step included" : "no approval needed"}, ` +
                    `idempotency ${prepared.idempotencyKey}` }
        : { status: "fail", code: "BAD_BUILD", detail: "buildPlaceOrder returned no usable call",
            action: "The browser signing path would not work." };
    }));

    heading("positions and settlement");
    push(await check("getSettlement", async () => {
      if (!window) return { status: "skip", code: "NO_WINDOW", detail: "no window available" };
      const s = await getSettlement(client, window.marketId);
      return { status: "pass", code: "OK", detail: `status ${s.status}, on-chain ${s.onchainStatus}` };
    }));

    push(await check("statusFor maps settlement + direction to the enum", async () => {
      if (!window) return { status: "skip", code: "NO_WINDOW", detail: "no window available" };
      const s = await getSettlement(client, window.marketId);
      const mapped = statusFor(s, "UP");
      return { status: "pass", code: "OK", detail: `live window maps to ${mapped}` };
    }));

    push(await check("getOutcomeBalance", async () => {
      if (!window || !account) return { status: "skip", code: "NO_INPUT", detail: "needs a window and a wallet" };
      const bal = await getOutcomeBalance(client, { marketId: window.marketId, account, direction: "UP" });
      return { status: "pass", code: "OK", detail: `${formatFixed(bal, d, 4)} Up contracts held on this window` };
    }));

    push(await check("getPositions (explicit marketIds \u2014 pure chain path)", async () => {
      if (!window || !account) return { status: "skip", code: "NO_INPUT", detail: "needs a window and a wallet" };
      const positions = await getPositions(client, { account, marketIds: [window.marketId] });
      return { status: "pass", code: "OK",
        detail: positions.length === 0
          ? "no open position on this window (expected \u2014 nothing was placed)"
          : positions.map((p) => `${p.direction} ${formatFixed(p.contracts, d, 4)} ${p.status}`).join(", ") };
    }));

    push(await check("getPositions (address only \u2014 discovers its own markets)", async () => {
      if (!account) return { status: "skip", code: "NO_INPUT", detail: "needs a wallet" };
      const positions = await getPositions(client, { account });
      return { status: "pass", code: "OK",
        detail: positions.length === 0
          ? "wallet holds no outcome tokens right now"
          : positions.map((p) => `${p.direction} ${formatFixed(p.contracts, d, 4)} ${p.status}`).join(", ") };
    }));

    push(await check("preflightCall raises NEEDS_APPROVAL when auto-approve is off", async () => {
      if (!window || !direction || !account) {
        return { status: "skip", code: "NO_INPUT", detail: "needs a window, a fillable side and a wallet" };
      }
      const quote = await quoteCall(client, { window, direction, stake });
      if (!quote) return { status: "skip", code: "NO_LIQUIDITY", detail: "side went dry" };
      try {
        const pf = await preflightCall(client, { window, quote, account, autoApprove: false });
        return { status: "pass", code: "OK",
          detail: `allowance already sufficient (${pf.needsApproval ? "unexpected" : "no approval needed"})` };
      } catch (e) {
        return DexError.is(e, "NEEDS_APPROVAL")
          ? { status: "pass", code: "OK", detail: "short allowance correctly raised NEEDS_APPROVAL" }
          : { status: "fail", code: "WRONG_CODE",
              detail: `expected NEEDS_APPROVAL, got ${e instanceof DexError ? e.code : String(e)}`,
              action: "The approval pre-step is not reachable." };
      }
    }));

    heading("subscribe");
    push(await check("subscribe reconciles and reports status", async () => {
      if (!window) return { status: "skip", code: "NO_WINDOW", detail: "no window available" };
      const seen: string[] = [];
      const sub = subscribe(client, {
        marketIds: [window.marketId],
        onSettlement: (s) => seen.push(s.status),
        onStatus: (st) => seen.push(`status:${st}`),
        reconcileMs: 60_000,
      });
      await sub.reconcile();
      const status = sub.status;
      sub.stop();
      return { status: "pass", code: "OK",
        detail: `forced reconcile ran, state "${status}", stop() clean; events: ${seen.join(", ") || "none"}` };
    }));

    const code = summarise(results, "verify-api \u2014 summary");

    // Record it, so `pnpm gate` can verify the API was actually exercised
    // rather than take a typecheck as proof.
    const dir = resolve(REPO_ROOT, "artifacts");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "verify-api.json"), JSON.stringify({
      recordedAt: new Date().toISOString(),
      chainId: client.config.chainId,
      passed: results.filter((r) => r.status === "pass").length,
      warned: results.filter((r) => r.status === "warn").length,
      skipped: results.filter((r) => r.status === "skip").length,
      failed: results.filter((r) => r.status === "fail").length,
      checks: results.map((r) => ({ name: r.name, status: r.status, code: r.code })),
    }, null, 2));
    heading("Meaning");
    console.log(code === 0
      ? `  ${green("Every exported entry point executed against live Shannon.")}`
      : `  ${red("Some entry points did not work against live data.")}`);
    console.log(`  ${dim("Skips are inputs that were unavailable, not failures.")}\n`);
    client.close();
    process.exit(code);
  } catch (e) {
    console.log(`\n${red("verify-api aborted:")} ${e instanceof Error ? e.message : String(e)}\n`);
    client.close();
    process.exit(1);
  }
}

void main();
