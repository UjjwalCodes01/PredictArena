# PLAN.md — UpDown League: Phase-Wise Build Plan

Target: **production-ready on Somnia Shannon testnet** by **7 Sep 2026** (submit 1 day before the 8 Sep 23:30 deadline). Today: 28 Aug → **11 working days**.

"Production-ready on testnet" means: any stranger with a wallet and faucet funds can use the deployed app end-to-end without help; it survives WS drops, API hiccups, wrong networks, and empty states; nothing requires localhost or manual DB edits; monitoring tells us when it breaks.

Each phase has an **exit gate** — do not start the next phase until the gate passes. If a phase overruns, cut from Phase 6 stretch items, never from gates.

---

## Phase 0 — Recon & Ground Truth (Day 1, ~28 Aug)

The single riskiest unknown is the Event Contracts API/contract surface. Resolve it before writing product code.

**Tasks**
1. Join hackathon Telegram; skim pinned messages + DoraHacks Q&A tab for rule clarifications.
2. Read https://docs.dreamdex.io/developers/event-contracts end-to-end. Record in `docs/dex-notes.md`:
   - How an Event Contract order is placed (contract call vs REST? function signature? payable? approval needed for USDso?)
   - Window schema: asset list, duration(s), open/close timestamps, how upcoming windows are queried
   - Settlement: how outcomes (WON/LOST/**VOID**) are exposed — event, endpoint, or both; timing after window close
   - Payout math: fixed payout ratio? where is it read from?
   - Token: USDso address + decimals on Shannon; STT gas expectations
   - Rate limits / auth requirements on stg API
3. Clone `dreamdex-bot-kit`; run `npx tsx scripts/doctor.ts` with a fresh burner wallet; get STT + USDso from testnet.somnia.network.
4. **Manually place ONE Event Contract order** (script or their UI) and watch it settle. Save the tx hash.
5. Fund 4 burner wallets (1 dev + 3 demo-seed). Keys in local `.env` only.

**Exit gate ✅** `docs/dex-notes.md` complete; one settled Event Contract tx hash recorded; 4 funded wallets. If docs are ambiguous on any point above → post question in Telegram same day, proceed with best-effort assumption clearly marked.

---

## Phase 1 — Repo, Tooling & the `dex` Package (Days 1–2)

**Tasks**
1. Scaffold pnpm workspace: `apps/web`, `apps/indexer`, `packages/dex`, `packages/db`, `scripts/`, `docs/`. Commit AGENTS.md, CLAUDE.md, `.env.example` (no secrets), `.gitignore` (env, db file, keys) — **first commit**.
2. CI (GitHub Actions): typecheck + lint + unit tests on push. Keep it under 2 min.
3. Build `packages/dex` (TypeScript strict, viem):
   - `getMarkets()` — markets + contract addresses + token decimals, cached w/ TTL, **never hard-coded**
   - `getWindows(asset)` — current + next windows w/ server-time offset
   - `placeCall({wallet, asset, windowId, direction, stakeWei})` — builds the tx for client-side signing; handles approval-if-needed as a returned pre-step
   - `getPositions(address)` / `getSettlement(windowId)` — REST reads
   - `subscribe(topics, onEvent)` — WS with auto-reconnect (backoff 1s→30s) + resubscribe
   - `DexError` codes: `WINDOW_CLOSED, INSUFFICIENT_STAKE, INSUFFICIENT_GAS, NEEDS_APPROVAL, ORDER_REJECTED, RATE_LIMITED, API_DOWN, UNKNOWN`
   - Request queue + retry w/ jitter on 429/5xx; all amounts `bigint`
4. `scripts/smoke.ts`: markets → place min-stake call (dev burner) → poll until settled → print result. This is the canary for the whole project.

**Exit gate ✅** `pnpm smoke` completes a live round-trip on Shannon and exits 0. CI green.

---

## Phase 2 — Data Layer & Indexer (Days 3–4)

**Tasks**
1. `packages/db` (SQLite + Drizzle) schema:
   - `calls` (id, wallet, asset, window_id, direction, stake_wei, tx_hash, status enum `PENDING|WON|LOST|VOID|FAILED`, placed_at, settled_at, week_id, idempotency key on (wallet, window_id) for scoring)
   - `windows` (window_id, asset, open_at, close_at, outcome, payout_ratio)
   - `wallets` (address, first_seen, display fields)
   - `sync_state` (cursor/last-reconciled timestamps)
2. `apps/indexer`:
   - WS subscription → upsert settlements/windows (idempotent writes only)
   - **Reconciliation poller every 45s**: any `PENDING` call older than window close → fetch truth from REST, update. This is the guarantee; WS is the optimization.
   - On startup: full reconcile of all non-terminal calls (covers downtime gaps)
   - Week assignment: `week_id` = ISO week (UTC) of window **close** time, computed once at insert
   - Structured logs (pino): every state transition logged with window_id + wallet
3. Scoring engine (`packages/db/scoring.ts`): pure function `(calls[]) → standings[]` implementing: win +10 × streak multiplier (3+ →×1.5, 5+ →×2 cap), void neither scores nor breaks streak, 1 scoring call per wallet per window, calibration % (min 5 settled), tie-break by calibration then earliest last win. **Table-driven vitest covering: streak build/break, void mid-streak, farming cap, ties, week boundary.**

**Exit gate ✅** Kill the indexer mid-pending-call, restart it, and the call still settles correctly via reconciliation. Scoring tests green (incl. void + cap cases). No float anywhere near amounts (grep check in CI).

---

## Phase 3 — Web App: Core Flow (Days 4–7)

Build in this order; each bullet is demo-able alone.

**Tasks**
1. **Wallet & network guard**: wagmi/viem connect (MetaMask + WalletConnect); wrong-chain banner with one-click add/switch to 50312 (`wallet_addEthereumChain` fallback); handle `accountsChanged`/`disconnect` by resetting session state; read-only browsing when no wallet.
2. **Windows feed**: BTC & ETH cards — current window (countdown from server-corrected clock), payout, next window preview. Loading/empty/error states from day one.
3. **Call flow**: tap Up/Down → stake presets (read USDso + STT balances first; on shortfall show the *specific* error + faucet link) → optional approval step (`NEEDS_APPROVAL`) → sign → optimistic `PENDING` row keyed by idempotency (button disabled on first tap) → tx receipt poll → on `ORDER_REJECTED`/revert mark `FAILED` with reason, never stuck-pending. Re-check window open at click time; if closed, roll to next window with a notice.
4. **My positions**: live list w/ countdowns; settlement flips status in ≤60s of indexer knowing (poll or SSE from our API — SSE preferred, polling acceptable).
5. **Leaderboard**: current-week standings (rank, W/L, streak 🔥, calibration %, points), week switcher, cold-start empty state that looks intentional, "resets Monday 00:00 UTC" footer.
6. **Profile page** (`/p/[address]`): stats + call history; this doubles as the share destination.
7. **Share card**: OG-image route (Next `ImageResponse`) — wallet, rank, streak, calibration. One "Share" button copying the profile link.

**Exit gate ✅** A tester on a fresh wallet completes connect → fund via faucet → call → settle → see themselves on the leaderboard **without any help**, on the deployed preview (not localhost). Manual matrix passes: reject signature, wrong network, zero USDso, zero STT, double-tap, mid-flow account switch.

---

## Phase 4 — Production Hardening (Days 7–8)

**Tasks**
1. **Deploy for real**: web on Vercel; indexer + SQLite on a small VPS/Fly.io/Railway with persistent volume; env-var docs in README. App must run without any localhost dependency.
2. Resilience drills (do these, don't assume):
   - Kill WS mid-pending → reconciliation resolves it
   - Block stg API (hosts file) → app shows degraded-mode banner, no white screen
   - Restart indexer + web mid-use → state recovers from DB + chain
3. **Monitoring**: uptime ping on web + indexer heartbeat row; Sentry (or equiv) on web; indexer error logs shipped somewhere visible. A dead indexer must be noticed within minutes, not at demo time.
4. Basic abuse/perf: our own API routes rate-limited per IP; leaderboard query indexed; markets metadata cached; Lighthouse pass ≥90 perf/accessibility on the two key pages.
5. Mobile pass at 390px: call flow + leaderboard fully usable.
6. Security sweep: no secrets in repo history (`gitleaks`), server derives all results from chain/API only, checksum-truncated addresses, dependencies audited.

**Exit gate ✅** All three resilience drills pass on the **deployed** stack. Monitoring alerts fire on a forced failure. Gitleaks clean.

---

## Phase 5 — Demo Assets & Submission (Days 9–10, submit 7 Sep)

**Tasks**
1. **Seed script** (`scripts/seed-demo.ts`): 3 demo wallets place real calls across several windows so the leaderboard has texture (streaks, a void if reproducible). Run it a day ahead so history exists.
2. **README** (judges read this — Technical is 25%): what/why, architecture diagram, live URL, quickstart, env table, **"How we use DreamDEX Event Contracts"** section listing every endpoint/contract call with a sample tx hash, known limitations, roadmap (copy-trading via session keys = vision).
3. **Demo video (2–3 min, scripted)**: 0:00 problem (predictions are solitary) → 0:20 solution → 0:40 LIVE demo: connect, place a call, show the wallet signature, show the pending countdown, cut to a settlement flipping WON, leaderboard reordering, share card → 2:20 impact (real onchain volume, new-user funnel) + roadmap → end on the URL. Record twice; pick the better take.
4. **SDK & docs feedback report** (optional deliverable — we submit it): concrete friction points from Phase 0–1 notes, what was great, what was missing. 1 page.
5. **Deck** (optional — we submit it): 6 slides max: problem, product, live screenshots, how it uses Event Contracts, traction plan, roadmap.
6. **Submit BUIDL on DoraHacks (7 Sep)**: repo link, video link, live URL, deck, feedback report; tags: DeFi / Prediction Markets / Event Contracts / Consumer. Post the BUIDL link in the hackathon Telegram.

**Exit gate ✅** BUIDL visible on the public list; video plays; live URL works from a phone on mobile data; a friend can replicate the flow from the README alone.

---

## Phase 6 — Buffer & Stretch (Day 11, 8 Sep)

Priority order, only if everything above is green:
1. Fix anything from final testing; edit BUIDL if needed (DoraHacks allows post-submission edits).
2. Stretch A: cosmetic "Follow" on leaderboard rows (roadmap teaser).
3. Stretch B: SSE live-updating leaderboard (if Phase 3 shipped polling).
4. Stretch C: Telegram share deep-link.
5. Do NOT deploy risky changes on deadline day after 12:00 — freeze by noon.

---

## Cross-Phase Rules

- Every day ends with: `pnpm typecheck && pnpm lint && pnpm test`, and `pnpm smoke` if `packages/dex` changed.
- Anything cut goes to `docs/cut-list.md` with one line of why.
- Any DreamDEX ambiguity → `docs/questions-for-telegram.md`, ask same day, don't silently guess.
- The core flow (connect → call → settle → leaderboard) is sacred: no commit may leave it broken overnight.

## Risk Register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Event Contract API differs from assumptions | Medium | Phase 0 resolves before product code; Telegram fallback |
| Testnet faucet dry / STT scarce | Medium | Fund 4 wallets on Day 1; hoard enough for demo week |
| stg API instability near deadline (everyone testing) | Medium | Record video by Day 10; degraded-mode UI; submit 7 Sep |
| Settlement latency longer than expected | Low | Demo edits around the wait; seed history in advance |
| Solo-dev time crunch | High | Gates + cut-list discipline; Phase 6 is the only flex zone |
| Void/edge outcomes unreproducible for testing | Medium | Unit-test scoring for VOID regardless; handle defensively |
