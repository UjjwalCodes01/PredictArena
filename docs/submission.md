# Prediction Leagues — BUIDL submission text

> Paste-ready for the DoraHacks form. Update the two ⚠️ placeholders (video
> link, and re-check the live stats the morning of submission — they grow) and
> delete this note.

---

## Prediction Leagues — the scoreboard for an entire venue

**Live:** https://predictarena-gamma.vercel.app · **Demo video:** ⚠️ VIDEO LINK
**Somnia Shannon testnet (50312) · DreamDEX Event Contracts**

Every prediction market shows you a P&L. A P&L cannot tell a good forecaster
from a lucky one — and over a weekend of five-minute BTC/ETH windows, luck is
most of what you're looking at.

Prediction Leagues answers the question the venue itself can't:

> **Are you actually good at this, or have you just been lucky?**

## The layer above

We didn't build another way to place a call. We built the ranking every call
on this venue lands on.

The leaderboard is derived from **public chain fills across the whole venue**
— every wallet trading these markets is scored, whether they've ever heard of
us or not. This week: **1,344 ranked players**, ~59,000 calls indexed, scored
by the same pure function with no exceptions. Place a trade through any app
built on DreamDEX Event Contracts and you're already on our board.

No local ledgers, no browser storage, nothing self-reported. A streak that
lives in localStorage is a story; a streak derived from chain fills is a
record.

## Scored like forecasting is actually scored

- **Brier score** — on a binary venue, the price you paid *is* your claim:
  buying Up at 62c asserts 62%. 0.250 is what coin-flipping scores; the field
  currently averages 0.262.
- **Edge** — realized win rate minus the average price the market charged you.
  Positive edge means you find sides the market underprices. Luck averages to
  zero over enough calls; edge doesn't.
- Both appear only after 5 settled calls — below that they're noise, and the
  board shows a dash rather than a number nobody should trust.

Points are **derived, never stored**: standings recompute from raw settlements
on every read, so a late void or corrected outcome is a recompute, not a
repair.

## An AI that plays — and can lose in public

Most AI in this space advises, and an advisor's track record is whatever its
author claims. Ours **plays**: its own wallet, real IOC orders through the
same code path as the button you press, ranked by the same Brier and Edge on
the same board. It estimates a probability, compares it to what the book
charges, and only trades when the gap clears a confidence-scaled threshold —
most looks end in a recorded **pass with its reason**, because a forecaster
that bets every window is a coin flip with a rationale attached. No branch in
the code could inflate its record: its standing is computed from chain-derived
calls by a function that has never heard of it.

## Deep Event Contracts integration

Every interaction is a real venue interaction — no mocks, no fixtures. Full
call-by-call table with a sample settled tx in the
[README](../README.md#how-we-use-dreamdex-event-contracts); highlights:

- Market discovery via `listBinaryVenueIds` / `listLiveBinaryMarkets` /
  `getBinaryMarket`, with **`getMarketOnchain` making tradability a chain fact,
  not an indexer guess** — addresses never hard-coded.
- Orders: `buildPlaceOrder` (browser signs) and `placeOrder` (AI + smoke),
  IOC with a tick-aligned protective limit and **exact approvals** — never
  `maxUint256`, the drainer signature wallet scanners flag.
- Settlement: `PENDING | WON | LOST | VOID | FAILED` as first-class states;
  voids neither score nor break streaks; winnings claimed via `redeem` with
  losing sides never redeemed (paying gas to receive 0).
- **Hard-won venue truths, tested:** approvals must cover *quantity*, not
  escrow (the pool escrows its worst case); `ImmediateOrCancelNoFill` arrives
  as a bare selector; both shipped as production incidents first and unit
  tests forever after. Filed upstream in [docs/sdk-feedback.md](sdk-feedback.md).

## Built to survive the venue

The venue's GraphQL indexer hangs at random — we measured a bare
`Market(limit:1)` query timing out at 31s while an invalid field errored in
1.6s. The site survives it: window discovery falls back to **rebuilding the
board from chain reads** behind a circuit breaker (measured: 503 → 200 in
9.2s, then 16ms cached). The AI forecaster rides the same fallback. Health
reports `ok / degraded / down` honestly instead of crying wolf.

Engineering posture: **414 tests** (money math table-driven, settlement
correction, slippage protection, signature replay); two custom lint rules in
CI (`bigint`-only money, mainnet references forbidden); atomic DB leases so
serverless concurrency can't double-spend; client input never trusted — wins
derive from chain reads only.

## Ecosystem impact

- **Pulls the venue's existing traders in** — 1,344 players are already
  ranked; the league is a reason to come back and trade more.
- **Generates real order flow** — every human call and every AI placement is
  a live IOC taker crossing the spread on the venue's own books.
- **Compounds other builders' apps** — trades placed through *any* DreamDEX
  surface land on our board. The more apps this hackathon produces, the more
  our leaderboard matters.
- **Roadmap: copy-trading via session keys** — the board already answers "who
  is worth following"; scoped, revocable delegation is the mechanism that acts
  on it. Seasons/divisions, more series as the venue lists them.

## Verify, don't trust

- Live: https://predictarena-gamma.vercel.app (in-app tUSDC faucet — an empty
  wallet completes the whole flow in under a minute)
- A settled call, end to end:
  https://shannon-explorer.somnia.network/tx/0xc48d49413de7ea0bde898c7bd5586c2885db52f133a2274a848fdc0e32f3fff8
- `pnpm smoke` — live round-trip: quote → place → settle → redeem, plus a
  projection-vs-chain assertion
- [AGENTS.md](../AGENTS.md) spec · [docs/dex-notes.md](dex-notes.md) venue
  ground truth · [docs/sdk-feedback.md](sdk-feedback.md) SDK report ·
  [docs/deck.html](deck.html) deck

*Testnet only, by design. No real funds, no KYC, mainnet ids rejected at
runtime and in CI.*
