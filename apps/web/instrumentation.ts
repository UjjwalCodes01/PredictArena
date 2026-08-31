/**
 * Server start-up warm-up.
 *
 * Next runs this once per server instance before it serves anything.
 *
 * The database is a serverless Postgres that suspends when idle, and waking it
 * takes ten to twenty seconds. Measured cold, `/api/standings` returned 503
 * after 41 seconds of retries; warm, the same request takes 4ms. Retrying
 * inside the request only moves that cost around -- the fix is to pay it here,
 * before anyone is waiting, so the first real visitor arrives to a warm system.
 *
 * Everything is best-effort. A failed warm-up must never stop the server from
 * booting: the request path has its own retry and the pages have their own
 * error states.
 */
export async function register(): Promise<void> {
  // Only the Node.js server runtime has a database to warm.
  if (process.env["NEXT_RUNTIME"] !== "nodejs") return;

  const started = Date.now();

  // Imported lazily so the edge runtime never pulls the driver in.
  const [{ serverDb, serverDex, dbRead }, { getStandings, currentWeekId }] = await Promise.all([
    import("./src/lib/server"),
    import("@predictarena/db"),
  ]);

  const legs: Array<{ name: string; run: () => Promise<unknown> }> = [
    {
      // The real leaderboard query, not a SELECT 1: it is the heaviest read the
      // app makes and the one that timed out cold. Retried here, where nobody
      // is waiting, rather than in the first visitor's request.
      name: "database",
      run: () => dbRead(() => getStandings(serverDb(), currentWeekId()), 4),
    },
    {
      name: "chain clock",
      run: async () => {
        const dex = serverDex();
        await dex.clock.ensureFresh();
      },
    },
  ];

  const results = await Promise.allSettled(legs.map((l) => l.run()));

  const report = results
    .map((r, i) => `${legs[i]!.name}: ${r.status === "fulfilled" ? "ready" : "FAILED"}`)
    .join(", ");
  const failed = results.filter((r) => r.status === "rejected").length;

  console.log(
    `[warm-up] ${report} (${Date.now() - started}ms)` +
      (failed > 0 ? " — the request path will retry what did not warm" : ""),
  );
}
