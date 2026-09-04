# Prediction Leagues

**A weekly league on [DreamDEX Event Contracts](https://docs.dreamdex.io/developers/event-contracts), on Somnia Shannon testnet.**

Call Up or Down on BTC and ETH in fixed windows. Win to build a streak and climb
the board. Then find out the thing prediction markets never tell you:

> **Are you actually good at this, or have you just been lucky?**

**Live: https://predictarena-gamma.vercel.app** · Testnet only — the tokens have no value.

---

## Why this exists

Every prediction market shows you a P&L. A P&L cannot distinguish a good
forecaster from a lucky one, and over a weekend of five-minute windows, luck is
most of what you are looking at.

This league scores you the way forecasting is actually scored:

- **Brier score** — the mean squared error between what you claimed and what
  happened. On a binary venue the price you paid *is* your claim: buying Up at
  62c asserts Up is 62% likely. **0.250 is what you score by saying "50%" every
  time** — the line between forecasting and guessing.
- **Edge** — your realized win rate minus the average price the market charged
  you. Back Up at 60c and win 70% of the time and your edge is +10.0: you are
  finding sides the market underprices. Brier alone rewards buying heavy
  favourites, which is confidence, not skill. Edge is the number that answers
  the question in the headline, because luck averages to zero over enough calls.

Both appear after 5 settled calls. Below that they are noise, and the board
shows a dash rather than a number nobody should trust.

### The leaderboard is not seeded

It scores **every wallet trading these markets**, derived from public chain
fills — not just people who signed up. As of writing: **1,210 wallets, 58,699
calls, 1,647 windows, 996 ranked players** in the current week. You are ranked
against people who have no idea the league exists, which is a much harder test
than a demo table of three seeded accounts.

---

## What's in it

| | |
|---|---|
| **Play** | Live windows, countdown, one-tap Up/Down, wallet signature, settlement |
| **Leaderboard** | Weekly, with Brier and Edge alongside points |
| **Duels** | Challenge another wallet head-to-head on a specific window |
| **AI player** | A forecaster that *plays* the league and is scored by the same rules |
| **Terminal** | Dense telemetry view of every live series |
| **Portfolio** | Your calls, their status, and claimable winnings |
| **Profile** | Wallet-signed display name and bio — no accounts, no passwords |

### The AI angle

Most AI in this space *advises* you, and an assistant's track record is whatever
its author claims. Ours doesn't advise. **It plays**: its own wallet, real
orders through the same code path as the button you press, ranked on the same
board by the same Brier and Edge.

It estimates a probability, compares it to what the book is charging, and places
an order **only when the gap clears a threshold** that widens when its own
confidence is low. Most of the time it passes — a forecaster that bets every
window is a coin flip with a rationale attached.

If it has no edge, the site says so. No branch could say otherwise: its record
is computed from chain-derived calls by a function that has never heard of it.
Details: [docs/ai-forecaster.md](docs/ai-forecaster.md).

---

## Architecture

```
                    ┌──────────────────────────────────────┐
   browser ───────► │  apps/web — Next.js 16 (App Router)  │
   wagmi/viem       │  React 19 · Tailwind 4 · RSC + API   │
   signs orders     └───────────────┬──────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
┌───────────────┐        ┌──────────────────┐        ┌──────────────────┐
│ packages/dex  │        │  packages/db     │        │  packages/ai     │
│               │        │                  │        │                  │
│ THE only seam │        │ Drizzle + Neon   │        │ forecaster:      │
│ to DreamDEX.  │        │ Pure scoring     │        │ prompt · decide  │
│ bigint money, │        │ engine (no I/O)  │        │ provider · agent │
│ typed errors  │        │                  │        │ Vertex AI / API  │
└───────┬───────┘        └────────▲─────────┘        └────────┬─────────┘
        │                         │                           │
        │                ┌────────┴─────────┐                 │
        │                │  apps/indexer    │                 │
        │                │  ingest·reconcile│                 │
        │                └────────▲─────────┘                 │
        │                         │                           │
        ▼                         │                           ▼
┌─────────────────────────────────┴───────────────────────────────────┐
│  Somnia Shannon testnet (chain 50312)                               │
│  DreamDEX Event Contracts · Envio/Hasura indexer · tUSDC (6dp)      │
└─────────────────────────────────────────────────────────────────────┘
```

**Five rules the codebase actually enforces**, not just aspires to:

1. **The chain is the source of truth.** The database is a *projection*. Every
   row is re-derivable from chain state; on any disagreement the chain wins and
   the row is corrected. Nothing is ever patched by hand.
2. **All DreamDEX I/O goes through `packages/dex`.** The UI and the indexer never
   reach the network directly.
3. **No floats for money.** Amounts are `bigint` end to end; formatting happens
   only at display. Enforced by [`scripts/lint-no-float-money.ts`](scripts/lint-no-float-money.ts),
   which fails CI — it scans 88 files.
4. **Testnet only.** Mainnet chain id, RPC and API are rejected at runtime and by
   [`scripts/lint-no-mainnet.ts`](scripts/lint-no-mainnet.ts).
5. **Client input is untrusted.** Wins and losses are derived from chain reads
   only, never from anything a browser posts.

Points are **derived**, never stored: standings are recomputed from raw
settlements on every read, so a late correction is a recompute rather than a
repair. That is why [`computeStandings`](packages/db/src/scoring.ts) is a pure
function with no I/O, no clock and no randomness — and why it is table-tested.

---

## How we use DreamDEX Event Contracts

Everything below is a real call in [`packages/dex`](packages/dex/src), the single
seam to the venue. No mocks; the demo runs against live Shannon.

### Market discovery — [`markets.ts`](packages/dex/src/markets.ts), [`windows.ts`](packages/dex/src/windows.ts)

| SDK call | Used for |
|---|---|
| `listBinaryVenueIds()` | Discover venues — ids move, so they are never hard-coded |
| `listBinaryAssets()` | Which series exist (BTC, ETH) |
| `listLiveBinaryMarkets()` | Page through live windows (pagination followed, not assumed) |
| `getBinaryMarket(marketId)` | Window metadata: strike, open/close, interval |
| `getMarketOnchain(marketId)` | **Chain-read status**, so `isTradable` is a fact not a guess |

Contract addresses are loaded from the venue, never hard-coded.

### Pricing — [`orders.ts`](packages/dex/src/orders.ts)

| SDK call | Used for |
|---|---|
| `getBinaryOrderBook(pool, {depth})` | Top of book per outcome, for the feed and the AI |
| `getBinaryBookParams(pool)` | Tick and lot grids — every price is quantized to them |

### Placing a call — [`orders.ts`](packages/dex/src/orders.ts)

| SDK call | Used for |
|---|---|
| `createTrader(...)` | Signer-bound trader |
| `trader.buildPlaceOrder(...)` | Unsigned call for the browser wallet to sign |
| `trader.placeOrder(...)` | Server-side path (AI forecaster, smoke test) |
| `trader.faucet()` | Mint testnet collateral in-app |

Orders are **IOC** by default: fills what the book offers, cancels the rest.
FOK turns a thin book into a hard failure, and liquidity gaps at window rolls
are a measured reality here, not a hypothetical.

**Two things we got wrong first, both now pinned by tests:**

- **Approvals must cover `quantity`, not `escrow`.** A binary contract settles at
  up to 1.0 collateral, so the pool escrows against the contract count. Approving
  the escrow reverts with `ERC20InsufficientAllowance` (`0xfb8f41b2`). We build
  an **exact** approval rather than the SDK's `maxUint256` — an unlimited
  approval is also what makes wallet security scanners warn your users.
  ([`approval.test.ts`](packages/dex/src/__tests__/approval.test.ts))
- **`ImmediateOrCancelNoFill` (`0xd48c4403`) arrives as a bare selector**, not a
  message. Matching on text alone silently misclassified "the book was empty" as
  a crash. ([`unfillable.test.ts`](packages/dex/src/__tests__/unfillable.test.ts))

### Settlement and redemption — [`positions.ts`](packages/dex/src/positions.ts)

| SDK call | Used for |
|---|---|
| `getOutcomeBalance(...)` | Position size per outcome |
| `getClaimable(...)` | What a settled winner may claim |
| `trader.redeem(...)` | Claim winnings |

Winnings are **claimed, not received** — a settled call is not a paid call, and
the UI says so rather than showing a balance that has not arrived.

**Position status is an enum** — `PENDING | WON | LOST | VOID | FAILED`.
Booleans are forbidden: a void is a first-class outcome, not an error, and it
neither scores nor breaks a streak.

### A real settled call

```
tx     0xc48d49413de7ea0bde898c7bd5586c2885db52f133a2274a848fdc0e32f3fff8
side   UP → WON
stake  75.700000 tUSDC   →   100.000000 contracts (implied 75.7%)
```
https://shannon-explorer.somnia.network/tx/0xc48d49413de7ea0bde898c7bd5586c2885db52f133a2274a848fdc0e32f3fff8

### Errors are machine-readable

`packages/dex` throws `DexError` with a `code` — `WINDOW_CLOSED`,
`INSUFFICIENT_STAKE`, `INSUFFICIENT_GAS`, `NO_LIQUIDITY`, `NEEDS_APPROVAL`,
`CHAIN_MISMATCH`, `RATE_LIMITED`, `API_DOWN`. The UI switches on the code to
show something actionable — a faucet link for a balance problem, a network
switch for the wrong chain. A generic "Something went wrong" is treated as a bug.

---

## Quickstart

```bash
pnpm install
cp .env.example .env
pnpm wallets          # generate fresh testnet burner keys into .env
pnpm faucet           # fund them with STT (gas) and tUSDC (stakes)
pnpm db:migrate       # apply schema to your Neon project
pnpm dev              # http://localhost:3000
```

Verify the integration against live Shannon before trusting anything:

```bash
pnpm doctor      # environment and connectivity
pnpm db:check    # schema, projection, leaderboard — read-only
pnpm smoke       # LIVE round trip: quote → place → settle → redeem
pnpm ai:probe    # forecaster dry run: calls the model, signs nothing
```

Every change runs `pnpm typecheck && pnpm lint && pnpm test` (377 tests).

---

## Environment

| Variable | Required | What it is |
|---|---|---|
| `CHAIN_ID` | yes | `50312` (Shannon). Mainnet `5031` is rejected at runtime. |
| `RPC_HTTP_URL` | yes | `https://dream-rpc.somnia.network` |
| `RPC_WS_URL` | no | WebSocket RPC for the live tail |
| `INDEXER_URL` | yes | Envio/Hasura endpoint serving binary markets |
| `DATABASE_URL` | yes | Neon **pooled** connection string |
| `DEV_PRIVATE_KEY` | yes | Burner that places the smoke-test order |
| `SEED1..3_PRIVATE_KEY` | no | Extra burners for demo texture |
| `TARGET_ASSET` / `TARGET_INTERVAL_SEC` | no | Default series (`BTC`, `300`) |
| `STAKE_TUSDC` | no | Smoke-test stake, whole tUSDC |
| `WALLETCONNECT_PROJECT_ID` | no | Adds WalletConnect; injected wallets work without it |
| `CRON_SECRET` | no | Guards `/api/cron/ingest` if you drive ingestion externally |
| **AI forecaster** | | *configure one provider, or leave it off entirely* |
| `GOOGLE_CLOUD_PROJECT` | no | GCP project — selects **Vertex AI** |
| `GOOGLE_CLOUD_LOCATION` | no | `global`, or a specific location |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | no | Service-account key for serverless (no ADC on Vercel) |
| `GEMINI_API_KEY` | no | Selects the Gemini API directly, no GCP project needed |
| `AI_MODEL` | no | Defaults to `gemini-2.5-flash` |
| `AI_PRIVATE_KEY` | no | The forecaster's own wallet |
| `AI_STAKE_TUSDC` | no | Its stake per call |

`.env` is gitignored from the first commit. Only fresh testnet burner keys ever
go in it.

---

## Known limitations

Stated plainly, because a hackathon README that claims everything works is not
credible.

- **The indexer has no permanent host.** It is a daemon and there is nowhere free
  and reliable to run one — Vercel runs functions, and GitHub's scheduler
  demonstrably drops runs (one fired in an eight-hour window against a
  five-minute cadence). So the site keeps its own projection fresh off ordinary
  traffic: `/api/tick` runs one leg of the cycle when a page is viewed and the
  data has gone stale. This reacts on page views rather than in seconds, and an
  idle site drifts. It is the difference between "stale unless a worker is
  deployed" and "fresh whenever anyone looks".
- **A window whose entire life passes unobserved cannot be recovered.** The venue
  lists live markets only, so there is nothing left to enumerate afterwards. One
  early call is permanently unrecoverable for this reason.
- **Rate limiting is per-instance and in-memory.** Measured: 40 parallel requests,
  0 limited. It catches one client hammering one instance and nothing concurrent.
- **Testnet only, by design.** No mainnet, no real funds, no KYC.
- **The AI forecaster is not expected to print money.** Short-horizon crypto
  direction is close to a coin flip, and the system prompt tells the model so.
  The claim is that it is *measured*, publicly, by the same yardstick as everyone
  else — not that it wins.

## Roadmap

- **Copy-trading via session keys** — follow a forecaster with a proven Brier
  score and mirror their calls under a scoped, revocable key. The leaderboard
  already answers "who is worth following"; this is the mechanism that acts on it.
- **A permanent indexer host**, retiring the traffic-driven fallback.
- **Seasons and divisions** — promotion and relegation across weeks.
- **More series** as the venue adds them; nothing here is BTC/ETH-specific.

---

## Repository

| Path | Lines | What |
|---|---|---|
| [`packages/dex`](packages/dex) | 2,691 | The only seam to DreamDEX |
| [`packages/db`](packages/db) | 3,034 | Schema, queries, pure scoring engine |
| [`packages/ai`](packages/ai) | 1,899 | The AI forecaster |
| [`apps/web`](apps/web) | 8,807 | Next.js app |
| [`apps/indexer`](apps/indexer) | 897 | Ingest and reconcile |

**Further reading**

| Doc | What |
|---|---|
| [AGENTS.md](AGENTS.md) | Full product spec and architecture |
| [docs/dex-notes.md](docs/dex-notes.md) | Verified ground truth about the venue, with a status per claim |
| [docs/sdk-feedback.md](docs/sdk-feedback.md) | Integration feedback for the DreamDEX team |
| [docs/ai-forecaster.md](docs/ai-forecaster.md) | How the AI player works, and how to run it |
| [docs/cut-list.md](docs/cut-list.md) | What we deliberately did not build, and why |
| [docs/phase4-hardening.md](docs/phase4-hardening.md) | Resilience drills and security sweep |
| [docs/demo-video.md](docs/demo-video.md) | Shot script for the demo |
| [docs/deck.html](docs/deck.html) | Six-slide pitch deck (open in a browser) |

Built for the Somnia / DreamDEX hackathon, September 2026.
