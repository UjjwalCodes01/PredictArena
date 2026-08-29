# Phase 2 design — data layer, scoring, indexer

## Deviation: Neon Postgres instead of SQLite

PLAN.md and AGENTS.md specify SQLite ("Simple > fancy. One file, easy demo."). We are using **Neon
serverless Postgres** at your direction. Recording the trade honestly:

**What it costs.** A network hop on every query, a `DATABASE_URL` secret to manage, and a dependency
on a third party being up during the demo.

**What it buys — and why it is the better call here.** PLAN.md Phase 4 says "indexer + SQLite on a
small VPS/Fly.io/Railway with **persistent volume**". A SQLite file cannot be shared between a
Vercel-hosted web app and a separately-hosted indexer; that split is the single most awkward part of
the deployment plan. Neon removes it: both processes point at one URL, no volume, no
file-locking, and the web app can read the leaderboard directly from serverless functions. It makes
"any stranger with a wallet can use the deployed app" materially easier to reach.

**What does not change.** The DB is still a *projection* of chain truth, never a source of it
(AGENTS.md §3). On any mismatch we re-derive from chain rather than patching rows.

---

## Scoring — rules, and the ambiguities resolved

From AGENTS.md §4 and §5. Points are **derived data**: raw settlements are stored, points are
computed by one pure function, and recomputing must be idempotent.

| Rule | Value |
|---|---|
| Win | +10 × streak multiplier |
| Streak multiplier | streak 1–2 → ×1, 3–4 → ×1.5, 5+ → ×2 (capped) |
| Loss | 0 points, **breaks** the streak |
| Void | 0 points, does **not** break the streak |
| Calibration | wins / settled calls, **excluding voids**; `null` under 5 settled |
| Farming cap | at most **one scoring call per wallet per window** |
| Tie-break | higher calibration, then earlier last win, then wallet address |

### Ambiguities PLAN.md left open, and how they are resolved

These are decisions, not discoveries — each is pinned by a test so it cannot drift.

1. **Does the multiplier count the current win?** Yes. The 3rd consecutive win *is* the one that
   earns ×1.5. Reading it as "the streak before this win" would make ×1.5 first apply on the 4th,
   which is not how a player would count it.
2. **Points arithmetic is integer.** 10 → 15 → 20. No fractional points ever exist, so no float
   enters scoring at all.
3. **Streak is scoped to the week being scored.** The league resets Monday 00:00 UTC, so a streak
   cannot span the reset — otherwise a week's standings would not be computable from that week's
   calls alone, which breaks recomputability.
4. **Only settled calls participate.** `PENDING` and `FAILED` are ignored entirely: they neither
   score, nor break a streak, nor count toward calibration.
5. **Ordering for streaks is by window close time**, then window id, then call id — the moment the
   outcome became known, not when the call was placed. Fully deterministic on ties.
6. **The farming cap keeps the earliest call** per (wallet, window) by placement time, then id.
   Later calls on the same window still exist on-chain and in the DB; they simply do not score.
7. **Final tie-break is wallet address ascending**, so two identical records still produce a stable
   order rather than a random one.

### Edge cases covered by tests

streak build 1→2→3→4→5 · loss breaking a streak · void mid-streak preserving it · void excluded
from calibration · calibration below the 5-call minimum · farming cap · pending/failed ignored ·
ties on points, on calibration, on last-win · week boundary assignment · empty input ·
recomputation idempotence.

---

## Week assignment

`week_id` is the **ISO-8601 week of the window's close time in UTC**, e.g. `2026-W35`, computed once
at insert. Close time, not placement time: a call placed at 23:59 Sunday on a window closing 00:01
Monday belongs to the new week, which is the boundary the UI states.

ISO weeks start Monday and week 1 is the week containing 4 January — so 1 Jan can belong to week 52
or 53 of the *previous* year, and 31 Dec can belong to week 1 of the *next*. Both are tested.

---

## Indexer

- **Reconciliation every 45s is the guarantee**; the live tail is the optimisation.
- **Idempotent upserts only** — every write is safe to replay, which is what makes recovery a
  restart rather than a repair.
- **On startup, reconcile every non-terminal call**, covering downtime gaps.
- Chain is truth. A row that disagrees with chain is corrected from chain, never the reverse.


---

## What shipped

```
packages/db/src/
  schema.ts     4 tables, 3 enums, Drizzle on Neon Postgres
  queries.ts    idempotent upserts + the leaderboard read
  scoring.ts    the pure engine -- no clock, no randomness, no I/O
  week.ts       ISO-8601 week assignment, UTC
  migrate.ts    applies drizzle/*.sql, with its own ledger
apps/indexer/src/
  main.ts       ingest 20s | reconcile 45s | heartbeat 30s
  ingest.ts     mirrors live windows
  ingest-calls.ts  derives CALLS from chain fills -- never from a client
  reconcile.ts  the guarantee
```

`pnpm db:generate` `db:migrate` `db:check` `indexer` `gate:phase2` were added.

## Exit gate

PLAN.md: *"Kill the indexer mid-pending-call, restart it, and the call still settles."*

Timing a real SIGKILL makes a flaky test -- the first attempt proved nothing because the indexer had
already finished the work before the signal landed. So `pnpm gate:phase2` asserts the **property**
that makes the gate true: a cold process, holding no memory, recovers every overdue call by
re-reading the chain. That is the exact code path a restart takes, and it is deterministic.

Measured on live data: **24 overdue calls, 24 recovered (17 LOST, 7 WON), second pass settled 0.**

Scoring validated against real chain data rather than only fixtures: the week's leader had five
consecutive wins and scored **70 points** -- 10+10+15+15+20, the multiplier curve working end to end,
matching the unit test exactly. Calibration appeared at 5 settled calls and showed a dash below it.

## Defects found and fixed while building

1. **A stub-row bug of my own making.** The reconciler used `upsertWindow` to record a settlement,
   but it knows a window id and not the window's asset or week -- so if the window had never been
   ingested it would have INSERTED a row with empty strings. Replaced with `markWindowSettled`, an
   UPDATE that reports the gap loudly instead of fabricating a row.

2. **The unique key rejected legitimate orders.** It was `tx_hash` alone, but one order can sweep
   several price levels and produce several fills sharing a transaction. Now `(tx_hash, direction)`,
   with fills aggregated into one call per user action -- because the player tapped once.

3. **`getWindows` was 10.5s for seven windows.** It read on-chain status in a sequential loop at
   ~1.5s each. This is a product bug, not just an indexer one: Phase 3's UI calls it on every page
   load. Now concurrent, bounded by the request queue.

4. **Fills were fetched as a single page.** AGENTS.md says never assume one page. Live windows carry
   a handful of fills today, so nothing was being lost -- but a busy demo window is exactly when a
   dropped tail would cost real league entries. Now paginated with a page cap.

5. **`db:check` misread Postgres enums.** `array_agg` comes back as an array literal string over the
   HTTP driver, not a JS array.

## Operational finding for Phase 4

`kill -9` on the `npx`/`pnpm` wrapper **orphans the worker**: it kept running for four minutes,
writing to the database, and corrupted a measurement before I noticed. Signals do not cross the
wrapper.

Phase 4 must run the indexer as a direct `node`/`tsx` process under a supervisor that signals the
real PID (systemd, a container entrypoint, Railway/Fly's own runner) -- not via a package-manager
wrapper. Otherwise a "restarted" indexer can end up as two indexers.
