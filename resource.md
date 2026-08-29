# Somnia × DreamDEX — Event Contracts Hackathon: Complete Resource Guide

> Personal build reference. Last updated: 28 Aug 2026. Verify anything time-sensitive on the official pages before relying on it.

---

## 1. Event Overview

| Item | Detail |
|---|---|
| Name | Event Contracts Hackathon |
| Hosts | Somnia Network × DreamDEX, organized on DoraHacks |
| Format | Virtual / online, worldwide, solo or team |
| Prize pool | $5,000 USDso (single **Open Track** — no sub-tracks) |
| Registration opened | 18 Aug 2026 |
| Submission window | 25 Aug 2026 → **8 Sep 2026, 23:30** |
| Time remaining | ~11–12 days (as of 28 Aug) |
| Registered hackers | 221 |
| Submitted BUIDLs | 7 (expect a spike in the last 72 hours) |
| Extra rewards | Social media spotlight, Somnia community showcase, Discord showcase series |

**What Event Contracts are:** dreamDEX's Up/Down trading feature. Traders call the market direction over a fixed time window. Correct call = fixed payout; wrong call = lose only the stake. Zero fees. Settles onchain on Somnia in USDso.

---

## 2. All Official Links

### Hackathon pages
- Detail page: https://dorahacks.io/hackathon/event-contracts/detail
- BUIDL list (submissions): https://dorahacks.io/hackathon/event-contracts/buidl
- Hackers list: https://dorahacks.io/hackathon/event-contracts/hackers
- Join a team: https://dorahacks.io/hackathon/event-contracts/team
- Q&A / Ask a question: https://dorahacks.io/hackathon/event-contracts/qa
- Organizer page: https://dorahacks.io/org/3427/hackathon

### Developer resources (from the official brief)
- **DreamDEX Bot Kit (GitHub):** https://github.com/somnia-chain/dreamdex-bot-kit
- **DreamDEX Bot Builder:** https://dreambot-builder.vercel.app/
- **Event Contracts docs (primary reference — read first):** https://docs.dreamdex.io/developers/event-contracts
- DreamDEX docs root: https://docs.dreamdex.io
- DreamDEX site: https://www.dreamdex.io/
- Somnia: https://somnia.network
- Testnet faucet / portal (test STT): https://testnet.somnia.network

### Community & support
- **Hackathon Telegram dev group (join immediately — updates + queries):** https://t.me/+XHq0F0JXMyhmMzM0
- DoraHacks Telegram: https://t.me/dorahacksofficial
- DoraHacks Discord: https://discord.gg/gKT5DsWwQ5
- DoraHacks email: hi@dorahacks.com

### Network / API endpoints (from bot kit README)
| | Mainnet | Shannon Testnet (build here) |
|---|---|---|
| Chain ID | 5031 | **50312** |
| RPC | https://api.infra.mainnet.somnia.network | **https://dream-rpc.somnia.network** |
| REST API | https://api.dreamdex.io/v0 | **https://stg.api.dreamdex.io/v0** |
| WebSocket | wss://api.dreamdex.io/v0/ws/public | **wss://stg.api.dreamdex.io/v0/ws/public** |

Contract addresses: in `packages/core` of the bot kit, or fetch at runtime from `GET /v0/markets`. **Never hard-code addresses.**

---

## 3. Submission Requirements

**Mandatory:**
1. Working prototype **on testnet** (Shannon, chain 50312)
2. Public GitHub / GitLab / Bitbucket repository
3. **2–3 minute demo video**

**Optional (submit both — cheap credibility points):**
4. Presentation deck
5. Feedback report on the SDK and documentation

Submit via "Submit BUIDL" on the detail page. BUIDLs can be edited after submission (Profile → Edit BUIDL).

---

## 4. Judging Criteria (build to this)

| Criterion | Weight | What it really means |
|---|---|---|
| Technical Implementation | **25%** | Real, working use of DreamDEX Event Contracts + APIs/SDKs. Live testnet orders beat mockups. |
| Innovation & Originality | 20% | Novel use of Event Contracts on a real problem. |
| UX & Design | 20% | Intuitive, accessible, compelling. Polish counts. |
| Business & Ecosystem Impact | 20% | Attracts new users, generates trading activity, grows Event Contracts adoption, sustainable. |
| Presentation & Demo | 15% | Problem → solution → product → demo → future vision, clearly, in 2–3 min. |

Key insight: the three "soft" criteria total 60%. A polished, usable product with real integration beats a clever but rough hack. "Production-ready rather than proof-of-concept" is stated explicitly.

---

## 5. Chosen Project: **Prediction Leagues**

**One-liner:** A weekly competitive league where players make wallet-signed Up/Down calls on BTC/ETH Event Contract windows, climb a leaderboard, build streaks, and get a calibration score — turning solitary predictions into a social game that generates real trading volume.

**Why this wins on the rubric:**
- Innovation 20%: social/competitive layer untouched by all 7 current entries.
- Technical 25%: real order placement + settlement tracking via REST/WS, no novel contracts needed → achievable in 12 days.
- UX 20%: leaderboards/streaks are inherently demo-friendly.
- Impact 20%: the product *is* "attract users + generate trading activity."
- Presentation 15%: live leaderboard updating on settlement = great video moment.

**Core scope (must ship):**
1. Wallet connect (Somnia Shannon testnet)
2. Show current/upcoming Up/Down windows for BTC & ETH (from REST/WS)
3. One-tap Up/Down call with preset stake → wallet-signed Event Contract order
4. Track settlement → update leaderboard (rank, W/L, streak, calibration %)
5. Weekly league reset + shareable result card

**Stretch (only if ahead of schedule):**
- "Follow" a top predictor (cosmetic v1; real copy-trading via session keys is the vision-slide roadmap)
- Telegram mini-app wrapper

**Competitive landscape (7 current entries — avoid these lanes):**
- Risk/safety tooling (crowded, 3 entries): Sluice Markets, Vitamin M/Verified Markets, rampart
- Agent evaluation (2): Rivo Intelligence, QDS
- Novel UX (2): Branch (conditional sequences), Market Dungeon (roguelite)
- **Empty lanes:** social/multiplayer ✅ (ours), analytics dashboards, Reactivity-native automation, non-crypto consumer onboarding

---

## 6. Technical Notes & Gotchas

- **⚠️ Contract upgrade (June 2026):** old `placeTakerOrderWithoutVault` is REMOVED. Use the single payable `placeOrder(...)` which auto-pulls funds from the wallet. Most code in `examples/` uses the OLD signature — copy patterns from `packages/core` and `strategies/` instead.
- Bot kit provides: shared client (auth, REST, WS, order execution, nonce manager, gotcha guards) in **TypeScript and Python**; five strategies (market-making, grid, momentum, mean-reversion, twap); docs on architecture, gotchas, 24/7 ops, **session keys** (hot key that can trade but cannot withdraw — great trust story to mention).
- First commands after cloning:
  ```
  npm install
  cp .env.example .env      # add PRIVATE_KEY, keep NETWORK=testnet
  npx tsx scripts/doctor.ts # read-only sanity check: wallet, balances, order books
  ```
- Every strategy defaults to `DRY_RUN=true`. Watch logs before going live.
- Helper scripts: `doctor.ts`, `operator-setup.ts` (session keys), `inspect-and-clean.ts` (cancel open orders), `one-ioc.ts` (test full order lifecycle).
- The bot kit targets the **spot CLOB**; Event Contracts have their own docs section — read https://docs.dreamdex.io/developers/event-contracts before writing any code. If anything is unclear, ask in the hackathon Telegram (organizers are active there).
- Get testnet STT from https://testnet.somnia.network (the hackathon page also links a request form).

---

## 7. DO / DON'T

### DO
- ✅ Join the Telegram dev group on day 1 — announcements, testnet issues, and judge signals appear there.
- ✅ Read the Event Contracts docs end-to-end before coding.
- ✅ Run `doctor.ts` and place ONE manual test contract end-to-end before building anything.
- ✅ Build on **Shannon testnet (50312)** — it's the stated requirement.
- ✅ Show real wallet-signed orders and real settlement in the demo video.
- ✅ Submit the optional SDK/docs feedback report — low effort, high signal.
- ✅ Seed the leaderboard with 3–5 wallets before recording so the demo isn't empty.
- ✅ Script the video: problem (20s) → solution (20s) → live demo (90s) → vision (20s).
- ✅ Write a clean README: what it does, architecture diagram, how to run, contract/API surfaces used.
- ✅ Submit 1 day early (by 7 Sep). DoraHacks allows editing after submission.
- ✅ Keep scope to ONE polished flow.

### DON'T
- ❌ Don't build a mockup/figma-only "prototype" — testnet integration is mandatory and worth 25%.
- ❌ Don't copy from `examples/` — old, removed function signatures.
- ❌ Don't hard-code contract addresses — fetch from `GET /v0/markets`.
- ❌ Don't build in the crowded lanes (risk tooling, generic AI agents) — 5 of 7 entries are already there.
- ❌ Don't exceed 3 minutes on the video or spend it on slides instead of the live product.
- ❌ Don't commit your `PRIVATE_KEY` / `.env` to the public repo. Use a fresh burner wallet for testnet.
- ❌ Don't touch mainnet (5031) — unnecessary risk, not required.
- ❌ Don't wait until 8 Sep to submit — deadline-day traffic and upload issues are common.
- ❌ Don't skip the Q&A tab — check it for rule clarifications others have asked.

---

## 8. 12-Day Schedule

| Days | Goal |
|---|---|
| 1–2 (Aug 28–29) | Join TG, read Event Contracts docs, run doctor.ts, place 1 manual contract, faucet STT |
| 3–8 (Aug 30–Sep 4) | Build core loop: wallet connect → windows feed → place call → settlement tracker → leaderboard |
| 9–10 (Sep 5–6) | UI polish, seed demo wallets, weekly reset + share card |
| 11 (Sep 7) | Record video, write README + SDK feedback report, **submit** |
| 12 (Sep 8) | Buffer / fixes / edit BUIDL if needed |

---

## 9. Submission Checklist (final day)

- [ ] Prototype live on Shannon testnet, at least one real settled Event Contract visible
- [ ] Public repo, no secrets committed, README complete
- [ ] 2–3 min demo video uploaded and linked
- [ ] (Optional) deck attached
- [ ] (Optional) SDK/docs feedback report attached
- [ ] BUIDL submitted on DoraHacks + visible in the BUIDL list
- [ ] Announcement posted in TG group (visibility with organizers)
