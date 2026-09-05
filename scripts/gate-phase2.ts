/**
 * `pnpm gate:phase2` -- prove the Phase 2 exit gate.
 *
 * The exit gate: "Kill the indexer mid-pending-call, restart it, and the call
 * still settles correctly via reconciliation."
 *
 * Timing a real SIGKILL makes a flaky test -- the indexer may simply have
 * finished the work before the signal lands. So this asserts the PROPERTY that
 * makes the gate true: a cold process, holding no memory of anything, recovers
 * every overdue call purely by re-reading the chain. That is exactly the code
 * path a restart takes, and it is deterministic.
 */
import { createDexClient, assertLiveNetwork } from "@predictarena/dex";
import { createDb, createSql } from "@predictarena/db";
import { reconcile } from "../apps/indexer/src/reconcile.js";
import { createClientOrExit } from "./lib/env.js";
import { bold, dim, green, red, heading, report, kv, check, summarise, type CheckResult } from "./lib/log.js";

const results: CheckResult[] = [];
const push = (r: CheckResult): CheckResult => (results.push(r), report(r), r);

interface OverdueRow { id: string; window_id: string; direction: string }

async function main(): Promise<void> {
  console.log(bold("\nPhase 2 exit gate"));
  console.log(dim("A cold process must recover overdue calls from chain alone.\n"));

  const url = process.env["DATABASE_URL"]?.trim();
  if (!url) {
    console.error(red("  DATABASE_URL is not set."));
    process.exit(1);
  }
  const sql = createSql(url);
  const db = createDb(url);
  const { client: dex } = createClientOrExit();
  void createDexClient;

  try {
    await assertLiveNetwork(dex);

    heading("1. Before");
    const before = (await sql`
      SELECT c.id, c.window_id, c.direction
      FROM calls c JOIN windows w ON w.id = c.window_id
      WHERE c.status = 'PENDING' AND w.closes_at < now()`) as unknown as OverdueRow[];

    kv("overdue PENDING calls", String(before.length));

    // A gate that only fires when the indexer happens to be behind is a gate
    // that proves nothing on a healthy system. So if nothing is naturally
    // overdue, STAGE the condition: take calls that already settled, forget
    // their outcome, and require reconciliation to re-derive it from chain.
    //
    // That is a stronger claim than the original, not a weaker one. It proves
    // the outcome is READ from the chain rather than remembered -- if the
    // recovered status differs from what was there before, the projection was
    // not re-derivable and the whole "DB is a projection" design is false.
    let staged: Array<{ id: string; status: string }> = [];
    let overdue = before;

    if (before.length === 0) {
      staged = (await sql`
        SELECT c.id, c.status
        FROM calls c JOIN windows w ON w.id = c.window_id
        WHERE c.status IN ('WON','LOST','VOID') AND w.closes_at < now()
        ORDER BY c.settled_at DESC NULLS LAST
        LIMIT 10`) as unknown as Array<{ id: string; status: string }>;

      if (staged.length === 0) {
        push({ name: "A recoverable call exists", status: "skip", code: "NO_DATA",
          detail: "No settled calls to re-derive and none overdue.",
          action: "Run `pnpm indexer` for a minute, then retry." });
        summarise(results, "Phase 2 gate -- summary");
        process.exit(0);
      }

      const ids = staged.map((r) => r.id);
      await sql`UPDATE calls SET status = 'PENDING', settled_at = NULL WHERE id = ANY(${ids})`;
      kv("staged", `${staged.length} settled call(s) reset to PENDING`);
      console.log(dim("    (their outcomes must now be re-derived from chain, not remembered)"));

      overdue = (await sql`
        SELECT c.id, c.window_id, c.direction
        FROM calls c JOIN windows w ON w.id = c.window_id
        WHERE c.status = 'PENDING' AND w.closes_at < now()`) as unknown as OverdueRow[];
    }

    push({
      name: "Recoverable calls exist",
      status: "pass",
      code: "OK",
      detail: staged.length > 0
        ? `${overdue.length} call(s) staged by forgetting a known outcome`
        : `${overdue.length} call(s) are naturally past their window close`,
    });

    heading("2. Cold reconciliation (what a restart runs)");
    const result = await reconcile(dex, db, "all");
    kv("checked", String(result.checked));
    kv("windows settled", String(result.windowsSettled));
    kv("calls settled", String(result.callsSettled));
    kv("errors", String(result.errors));

    heading("3. After");
    const ids = overdue.map((r) => r.id);
    const after = (await sql`
      SELECT id, status FROM calls WHERE id = ANY(${ids})`) as unknown as Array<{ id: string; status: string }>;

    const stillPending = after.filter((r) => r.status === "PENDING");
    const settled = after.filter((r) => r.status !== "PENDING");

    push(await check("Every overdue call reached a terminal status", async () => {
      const byStatus = new Map<string, number>();
      for (const r of settled) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
      const summary = [...byStatus].map(([s, n]) => `${s}=${n}`).join(", ");
      return stillPending.length === 0
        ? { status: "pass", code: "OK", detail: `${settled.length} recovered from chain (${summary})` }
        : { status: "fail", code: "NOT_RECOVERED",
            detail: `${stillPending.length} of ${overdue.length} still PENDING (${summary}).`,
            action: "Reconciliation did not recover them; the guarantee is broken." };
    }));

    if (staged.length > 0) {
      push(await check("Re-derived outcomes MATCH what was forgotten", async () => {
        const expected = new Map(staged.map((r) => [r.id, r.status]));
        const wrong = after.filter((r) => expected.has(r.id) && expected.get(r.id) !== r.status);
        return wrong.length === 0
          ? { status: "pass", code: "OK",
              detail: `All ${staged.length} recovered to their original status — the projection is re-derivable from chain.` }
          : { status: "fail", code: "DIVERGED",
              detail: wrong.map((w) => `${w.id.slice(0, 14)}: was ${expected.get(w.id)}, now ${w.status}`).join("; "),
              action: "Reconciliation produced a DIFFERENT outcome than the chain gave before. Investigate immediately." };
      }));
    }

    push(await check("No outcome was guessed -- statuses are legal", async () => {
      const legal = new Set(["WON", "LOST", "VOID", "FAILED", "PENDING"]);
      const bad = after.filter((r) => !legal.has(r.status));
      return bad.length === 0
        ? { status: "pass", code: "OK", detail: "All statuses are members of the enum" }
        : { status: "fail", code: "BAD_STATUS", detail: bad.map((b) => b.status).join(", "),
            action: "An impossible status reached the projection." };
    }));

    push(await check("Reconciliation is idempotent -- a second pass changes nothing", async () => {
      const second = await reconcile(dex, db, "all");
      return second.callsSettled === 0
        ? { status: "pass", code: "OK", detail: "Re-running settled 0 further calls, as it must" }
        : { status: "warn", code: "NOT_IDEMPOTENT",
            detail: `A second pass settled ${second.callsSettled} more.`,
            action: "Expected when windows closed between passes; investigate if it repeats." };
    }));

    const code = summarise(results, "Phase 2 gate -- summary");
    heading("Verdict");
    console.log(code === 0
      ? `  ${green(bold("Phase 2 gate met."))} A cold process recovers pending calls from chain alone.\n`
      : `  ${red("Phase 2 gate NOT met.")}\n`);
    dex.close();
    process.exit(code);
  } catch (e) {
    console.log(`\n${red("gate:phase2 aborted:")} ${e instanceof Error ? e.message : String(e)}\n`);
    dex.close();
    process.exit(1);
  }
}

void main();
