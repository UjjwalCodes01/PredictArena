# AGENTS.md — Prediction Leagues (Somnia × DreamDEX Event Contracts Hackathon)

This file briefs any AI coding agent working in this repository. Read it fully before writing code. When this file conflicts with your assumptions, this file wins. When the official docs conflict with this file, the docs win — flag the conflict to the human.

---

## 1. What we are building

**Prediction Leagues** — a web app where users make one-tap Up/Down calls on BTC/ETH DreamDEX Event Contracts (fixed-window binary prediction markets on Somnia), and compete on a weekly leaderboard with streaks and a calibration score.

**One-liner for the demo:** "Turn solitary Up/Down trades into a social league that generates real onchain trading volume."

**Hackathon context:**
- Deadline: **8 Sep 2026, 23:30** — target submission **7 Sep**.
- Must run on **Somnia Shannon testnet (chain 50312)**. Never mainnet.
- Deliverables: working testnet prototype, public repo, 2–3 min demo video. Optional: deck + SDK feedback report (we ARE submitting both).
- Judging: Technical 25%, Innovation 20%, UX 20%, Impact 20%, Presentation 15%. Polish + real integration > cleverness.

## 2. Non-goals (do NOT build these)

- ❌ Real copy-trading / mirroring (vision slide only; a cosmetic "Follow" button is the max)
- ❌ Custom smart contracts of our own (we consume DreamDEX contracts/APIs only)
- ❌ Mainnet support, real funds, fiat, KYC
- ❌ User accounts/passwords — wallet address IS the identity
- ❌ Mobile native apps, Telegram bot (stretch only if core is done and polished)
- ❌ Admin panels, moderation, notifications infra

Scope creep is the #1 failure mode. One polished flow beats five rough ones.

## 3. Architecture

```
apps/web        Next.js (App Router) + wagmi/viem + Tailwind. Wallet connect,
                windows feed, Up/Down call UI, leaderboard, profile, share card.
apps/indexer    Node/TS worker. Subscribes to DreamDEX WS + polls REST.
                Tracks windows, order status, settlements. Writes to DB.
packages/dex    Thin client over DreamDEX REST/WS + viem contract calls for
                Event Contracts. THE ONLY module allowed to talk to DreamDEX.
db              SQLite (via Drizzle or Prisma). Simple > fancy. One file, easy demo.
```

- **Signing model:** all order placement is signed client-side by the user's wallet (browser). The indexer/server NEVER holds user keys. The server may hold ONE burner key for demo-seeding wallets only, loaded from env, testnet-only.
- **Source of truth:** the chain/DreamDEX API is truth for orders & settlements. Our DB is a cache/projection. On any mismatch, re-sync from API; never "fix" results locally.

### Network constants (verify at runtime, don't trust blindly)
| | Shannon testnet |
|---|---|
| Chain ID | 50312 |
| RPC | https://dream-rpc.somnia.network |
| REST | https://stg.api.dreamdex.io/v0 |
| WS | wss://stg.api.dreamdex.io/v0/ws/public |

- **Never hard-code contract addresses.** Fetch from `GET /v0/markets` at startup and cache with a TTL. The bot kit README says addresses live in `packages/core` and are re-fetchable — mirror that pattern.
- ⚠️ **June 2026 upgrade:** `placeTakerOrderWithoutVault` is removed; spot uses a single payable `placeOrder(...)` with auto-pull funding. Event Contracts may have a different surface — **read https://docs.dreamdex.io/developers/event-contracts before implementing `packages/dex`** and paste findings into `docs/dex-notes.md`. Do not copy from the bot kit's `examples/` folder (stale signatures). Copy patterns from `packages/core` and `strategies/`.

## 4. Core user flow (the ONE flow that must be flawless)

1. Connect wallet → auto-prompt network switch/add to Somnia Shannon (50312).
2. See current + next Up/Down windows for BTC and ETH (asset, direction odds/payout, window open/close time, countdown).
3. Tap **Up** or **Down** → choose stake from presets (e.g. 1 / 5 / 10 USDso) → wallet signature → order placed.
4. Position shows as **Pending** with live countdown → window closes → settlement detected → position flips to **Won / Lost / Void**.
5. Leaderboard updates: rank, W/L, current streak, best streak, calibration %, weekly points.
6. Profile page + shareable result card (static image or OG card).

Weekly league: ISO week, **resets Monday 00:00 UTC** (state it in the UI; see edge cases).

### Scoring (keep deterministic & recomputable from raw settlements)
- Win = +10 pts × streak multiplier (streak 3+ → ×1.5, 5+ → ×2, cap ×2)
- Loss = 0 pts. Void/cancelled = 0 pts, does NOT break streak.
- Calibration % = wins / settled calls (exclude voids). Show "—" under 5 settled calls.
- Points are derived data. Store raw events; compute points in one pure function with unit tests. Never store points as the only record.

## 5. Edge cases — handle ALL of these

### Wallet & network
- Wrong network → block actions, show one-click "Switch to Somnia Shannon" (wallet_addEthereumChain fallback if chain unknown).
- No wallet installed → show install links, keep app browsable read-only.
- Account switch mid-session → detect `accountsChanged`, reset session state, refetch positions for new address.
- Wallet locks / disconnects → same as above via `disconnect` event.
- User rejects signature → treat as clean cancel; no error toast spam, no phantom "pending" row.

### Funds & transactions
- Insufficient USDso stake → detect BEFORE signing (read balance), show faucet link + how to get test funds.
- Insufficient native STT for gas → separate, explicit message ("You need STT for gas") + faucet link. Do not show a generic failure.
- Tx submitted but order rejected by protocol (slippage/odds moved, window just closed, min size) → surface the revert reason if decodable; mark attempt as **Failed**, never Pending.
- Tx stuck/pending too long → timeout UI after N seconds with "check explorer" link; poll receipt in background; reconcile on confirm.
- Duplicate submission (double-tap) → disable button on first click; idempotency key per (wallet, market, window) in DB; if the API supports client order IDs / userData, use them.
- Auto-pull funding model: user's first order may need a token approval depending on Event Contract surface — detect allowance and insert an Approve step in the UI if required. Test this path explicitly.

### Windows & timing
- Window closes while user is composing → re-check window state at click time AND server-side before recording; if closed, roll the UI to the next window with a notice, don't error.
- Clock skew — never trust client clock for cutoffs. Use API/chain time; display countdowns from a server-offset-corrected clock.
- A call placed at second-to-last moment may land after close → treat protocol rejection as Failed (see above), covered by the same path.
- Window boundary = league week boundary: assign a call to the week of its **window close (settlement)** time, decided once at placement. Document this rule in the UI footer.

### Settlement & data integrity
- Settlement event missed (WS drop) → indexer must ALSO poll REST for unresolved positions every 30–60s. WS is an optimization, polling is the guarantee.
- WS disconnects → exponential backoff reconnect (1s→2s→4s… cap 30s), resubscribe, then run a reconciliation poll for anything missed during the gap.
- **Void / cancelled / invalid market** outcomes exist (competitor pitches confirm "void" is a real state) → model outcome as enum `WON | LOST | VOID | FAILED | PENDING`, never boolean.
- Stake refunds on void → reflect in UI ("Voided — stake returned").
- API returns partial/paginated data → always follow pagination; never assume one page.
- Reorg/late correction of a settlement (rare on testnet but possible) → recompute derived scores from raw records on reconciliation; scores must be idempotent to recompute.
- Decimals: USDso amounts are integers onchain (check token decimals from `/v0/markets` or token contract; likely 6 or 18). Do ALL math in bigint; format only at the display edge. No floats for money, ever.

### API & infra
- Rate limits on staging API → centralize all calls in `packages/dex` with a small request queue + retry w/ jitter on 429/5xx. Cache market metadata.
- Staging API downtime → app degrades to read-only with a banner; never white-screen. Wrap all fetches in error boundaries.
- Testnet faucet dry / STT hard to get → keep 2–3 pre-funded demo wallets ready (keys in local `.env`, never committed) so the demo video can be recorded regardless.
- Nonce management for the seed/demo bot wallet → serialize its txs (single queue), mirroring the bot kit's nonce-manager approach.

### Leaderboard & league
- Empty leaderboard (cold start) → seed 3–5 demo wallets with real testnet calls before recording; also design an attractive empty state.
- Ties → break by (higher calibration %, then earlier last-win timestamp).
- Same wallet spamming tiny calls to farm points → cap points-earning calls per wallet per window to 1 (extra calls still allowed onchain, just don't score). Document this.
- Week rollover while user is viewing → leaderboard queries are parameterized by week id; UI has a week switcher; "live" defaults to current week.

### Security
- **Never commit secrets.** `.env` in `.gitignore` from commit #1. Only `PRIVATE_KEY` for the testnet demo bot lives in env; it must be a fresh burner.
- Server trusts nothing from the client: position/settlement writes come only from the indexer's own API/chain reads, keyed by wallet address recovered from the chain — the client never posts "I won".
- If we add any signed-message login (SIWE), verify signature server-side; otherwise keep the app stateless per wallet (preferred, simpler).
- Address display: checksum + truncate (0x1234…abcd); support ENS-style names only if trivial, else skip.

## 6. Build order (agents follow this sequence)

1. `packages/dex`: markets fetch, window feed, place-order call, position/settlement read. **Prove with a CLI script that places 1 real testnet order and detects its settlement.** Nothing else starts until this works.
2. `apps/indexer`: WS + polling reconciliation → DB writes. Idempotent upserts only.
3. `apps/web`: wallet connect + network guard → windows feed → call flow → positions.
4. Leaderboard + scoring (pure function + tests) → profile → share card.
5. Polish pass: empty states, loading states, error banners, mobile viewport.
6. Demo seeding script, README, video, SDK feedback report.

Definition of done for ANY task: works against live Shannon testnet, handles its listed edge cases, has an error state, and doesn't regress the core flow.

## 7. Testing & verification

- Unit-test the scoring function and week-assignment logic (pure functions, table-driven).
- Integration smoke script (`scripts/smoke.ts`): fetch markets → place min-stake order (burner wallet) → await settlement → assert DB projection matches API. Run before every demo recording.
- Manual test matrix (must pass before submission): reject signature, wrong network, zero USDso, zero STT, double-tap, WS kill (offline toggle) during pending position, void outcome (if reproducible), week boundary display.
- Money math: property test — format(parse(x)) round-trips; no float appears in any file that imports the dex package (lint rule or grep in CI).

## 8. Conventions

- TypeScript strict everywhere. `bigint` for all onchain amounts.
- All DreamDEX I/O behind `packages/dex`; UI and indexer import it, never fetch directly.
- Errors: typed result objects or thrown `DexError` with a machine `code` + human `message`; UI switches on `code`.
- Commit style: `feat: …`, `fix: …`, small commits; repo must be readable by judges.
- README must contain: what/why, architecture diagram, quickstart, env var table, "how we use DreamDEX" section (judges look for this — it's 25% of the score).
- No secrets, no mainnet config, no `examples/`-style stale calls.

## 9. Reference links

- Event Contracts docs (READ FIRST): https://docs.dreamdex.io/developers/event-contracts
- Bot kit (client patterns, nonce mgr, session keys, gotchas): https://github.com/somnia-chain/dreamdex-bot-kit
- Bot builder: https://dreambot-builder.vercel.app/
- Testnet faucet: https://testnet.somnia.network
- Hackathon detail: https://dorahacks.io/hackathon/event-contracts/detail
- Hackathon Telegram: https://t.me/+XHq0F0JXMyhmMzM0

## 10. When unsure

- Ambiguity in the Event Contract API surface → check docs, then bot kit source, then draft a question for the human to post in the hackathon Telegram. Do not guess silently.
- Any change that touches money math, order placement, or settlement handling → write the test first.
- If a feature endangers the 7 Sep submission target, cut it and note it in `docs/cut-list.md`.
