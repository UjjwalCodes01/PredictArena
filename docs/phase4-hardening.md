# Phase 4 — Production hardening

What was done, with what was measured rather than assumed.

---

## Why the Vercel deployment failed

CI passed and Vercel failed, which narrows it to something CI does not evaluate. Two causes, both
fixed:

1. **A cron schedule the plan rejects.** `vercel.json` asked for `*/5 * * * *`. Vercel's Hobby plan
   caps cron frequency at once per day and rejects anything finer **at deploy time** — the build
   fails outright, and no amount of local testing surfaces it. Now `0 3 * * *`, which every tier
   accepts.

2. **An import that escaped the build root.** `/api/cron/ingest` reached into the indexer by
   relative path (`../../../../../../indexer/src/ingest`) without declaring the dependency. That
   resolves locally and is not guaranteed to be in Vercel's build context when Root Directory is
   `apps/web`. `apps/indexer` now exports a public surface, `apps/web` depends on it as
   `workspace:*`, and the import is by package name. Verified with a clean-tree
   `pnpm install --frozen-lockfile && next build` — what Vercel actually runs.

## 1. Deploy for real

Web is live on Vercel. The indexer now has deployable config:

- `apps/indexer/Dockerfile` — runs anywhere that keeps a process alive
- `apps/indexer/railway.json`, `apps/indexer/fly.toml`

The `CMD` is exec-form so the process is PID 1 and receives SIGTERM directly. Through a shell or a
package-manager wrapper the signal reaches the wrapper instead and the worker is orphaned — which
cost a corrupted measurement during Phase 2.

**If you cannot host it:** `.github/workflows/keep-fresh.yml` drives `/api/cron/ingest` every five
minutes from GitHub's scheduler, free on a public repository. Set `APP_URL` and `CRON_SECRET` as
repository secrets. A fallback, not an equal — the daemon tails live events and reacts in seconds,
a scheduled workflow reacts on a timer and is delayed under load.

## 2. Resilience drills

| Drill | Result |
|---|---|
| **Upstream venue unreachable** | PASS. Every page 200. The feed shows *"Could not load the live windows — your funds are unaffected, this is a read problem only"* with a retry. The leaderboard keeps working: different upstream. No white screen. |
| **Indexer stopped** | PASS. `/api/health` returns 503 naming the indexer. The UI shows "RESULTS DELAYED" rather than claiming the wallet has no calls. |
| **Restart mid-use** | PARTIAL, and the limit is measured. State recovers from database and chain, and the catch-up sweep re-scans windows it saw while live. It **cannot** recover a window whose entire life passed with the indexer down: the venue lists live markets only (`includeInactive` returns the same 14 rows), so nothing remains to enumerate. Recovering those needs a block-range log scan — a different and much larger job. |

## 3. Monitoring

`GET /api/health` checks the three things that fail independently and returns **200 only when all
are healthy**, so a plain HTTP uptime check alerts without parsing a body.

```json
{ "status": "down",
  "checks": {
    "database": { "status": "ok",   "detail": "reachable" },
    "indexer":  { "status": "down", "detail": "last reported 4878s ago; results are stale" },
    "chain":    { "status": "ok",   "detail": "5 live windows" } } }
```

Real output, taken while the indexer was genuinely down. Pinging the home page would not have
caught it — the site renders perfectly while the projection goes hours stale, which is exactly how
it failed in practice. Point an uptime monitor at `/api/health` on a 2-minute interval.

**Browser errors** now reach `POST /api/client-error`, which writes one structured JSON line to
stdout (Vercel ingests it) and forwards to Sentry when `SENTRY_DSN` is set. No SDK — the payload is
small and well-specified, and `@sentry/nextjs` would add real build weight for one POST. Adopting
Sentry is setting one variable, not a code change.

Verified: a report reaches the log, and a page stuck in an error loop is throttled (10 reports in,
5 accepted, 5 rejected). It records nothing the page did not already know — no wallet address, no
balances. An error channel must not quietly become a tracking one.

## 4. Abuse and performance

**Rate limiting** — a token bucket per IP on every API route, sized by cost (a quote reaches the
chain uncached, so it is tighter than a cached leaderboard read). Verified live:

- 25 rapid quote requests → 3 rate-limited (capacity 15 + refill = 22 served, as designed)
- a different IP unaffected
- the 4 requests a normal page load makes → 0 blocked

**Measured limit — stronger than the earlier caveat.** Against the live deployment, **40 parallel
requests were ALL served, none limited.** They spread across serverless instances, and each keeps
its own bucket, so a distributed burst never meets a single budget.

What it does still catch: one client hammering one instance — a page stuck in a retry loop, a
script run in a terminal. That is the realistic accident, and it is worth having.

What it does not catch: anything concurrent. Treat the numbers above (25 sequential requests, 3
limited) as evidence it works *within* an instance, not as protection for the deployment. Real
protection needs a shared store (Upstash/Redis) or the platform WAF. Not built, because adding a
per-request database write to protect the database is self-defeating, and this is a testnet game
with no funds at risk.

**Query performance**, measured at 910 rows:

| Query | Time |
|---|---|
| `getRecentCalls(50)` | 256ms |
| `getLeagueTotals` | 251ms |
| `getWalletCalls(50)` | 255ms |
| `getStandings(week)` | 1259ms |

The ~250ms floor is the round trip to Neon, not query time. `getStandings` is slower because it
fetches every call for the week to feed the pure scoring function. **No index was added**: the
filter and join are already covered by `calls_week_status_idx` and the windows primary key, so the
cost is payload size, and an index there would be cargo-culting. Stale-while-revalidate means users
see 3–18ms; only the background refresh pays it. Worth revisiting if a week ever holds tens of
thousands of calls.

## Lighthouse

Run against a production build, headless, on the two key pages.

| Page | Performance | Accessibility | Best practices | SEO |
|---|---|---|---|---|
| Play | **90** (was 82) | 96 | 100 | 100 |
| Leaderboard | **77** (was 76) | **100** (was 96) | 100 | 100 |

**What moved them.** The venue SDK was imported statically by the wallet hooks, which put ~535KB
of exchange client and elliptic-curve code into the bundle *every* page downloads — including the
leaderboard, which never constructs a client. It now loads on demand, the first time someone
touches a wallet. Play crossed the 90 target.

**Contrast was a genuine accessibility bug**, not a scoring quibble: the active nav link measured
3.08:1 and `ink-faint` body text 3.4:1, both under the 4.5:1 small text requires. Raised
`--color-ink-faint` and added a lighter `--color-accent-text` for text on the soft accent
background (the accent itself is unchanged, so buttons keep their colour). Leaderboard
accessibility went to 100.

**Leaderboard performance remains 77, below the ≥90 target.** The cost is rendering ~150 rows,
each with a generated SVG avatar, on the client. Fixing it means virtualising the list or
server-rendering the table — worth doing, not done. Recorded rather than rounded up.

## 5. Mobile at 390px

PASS. Verified after the responsive rework: single column, nav scrolls sideways rather than hiding
behind a menu, no horizontal overflow.

## 6. Security sweep

| Finding | Action |
|---|---|
| **drizzle-orm < 0.45.2 — SQL injection (HIGH)** | Upgraded to 0.45.2. A runtime dependency used by every query, not dev tooling. |
| **esbuild ≤ 0.24.2 — dev-server request forgery (MODERATE)** | Overridden to `>=0.25.0` in `pnpm-workspace.yaml`. Reached only through drizzle-kit's deprecated `@esbuild-kit/*` chain; dev-only, never shipped. |
| Secrets in git history | Clean. `.env` in 0 commits, no key material ever committed. The 64-hex strings in history are transaction hashes and venue ids. |
| Results derived from chain/API only | Yes — the server never trusts client-posted outcomes. |
| Client bundle | `pnpm check:bundle` scans every chunk for connection strings and `.env` values. Clean. |

`pnpm audit` reports **no known vulnerabilities**.

---

## Still open

- The indexer has config but **nothing is running it yet**. Deploy the container, or enable the
  GitHub schedule. Everything downstream stays stale until one of those happens.
