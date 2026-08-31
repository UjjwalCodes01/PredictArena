# The AI forecaster

## Why this shape

Every AI entry in the field builds an assistant: something that reads a market
and tells *you* what to do. That framing has a problem nobody selling it can
answer — **you cannot tell whether the advice is any good.** An assistant's
track record is whatever its author says it is.

This project already had the machinery to settle that question. The leaderboard
scores every player by Brier score (are your stated probabilities calibrated?)
and edge (do you beat the price you paid?). Those exist to answer "are you good,
or were you lucky?" for humans.

So the AI here does not advise. **It plays.** It holds its own burner wallet,
places real orders on the real venue through the same code path as the button a
human presses, and appears on the same leaderboard, ranked by the same pure
scoring engine. Nothing about it is special-cased.

The consequence is the point: **if it has no edge, the site says so.** There is
no branch anywhere that could report otherwise, because its record is computed
from chain-derived calls by a function that has never heard of it.

## How it decides

1. **Read.** Live window, the resting order book, and how the last twelve
   windows on that series actually resolved.
2. **Estimate.** Claude Opus 5 returns a probability that the window closes Up,
   in basis points, plus how much it trusts its own estimate.
3. **Compare.** A binary contract settles at exactly 1.0 collateral, so a
   probability and a price sit on the same scale and subtract directly. The gap
   is the edge.
4. **Act, or don't.** It places an order only when the edge clears a threshold —
   widened when the estimate is shaky. Most of the time it passes.

Passing is the feature. A forecaster that bets every window is a coin flip with
a rationale attached; the threshold is what makes it a forecaster.

## Architecture

`packages/ai`, deliberately split so the interesting parts are testable without
spending a token:

| File | What it is | Pure? |
|---|---|---|
| `prompt.ts` | What the model is told; validation of what comes back | yes |
| `decide.ts` | Whether an estimate is worth trading | yes |
| `forecast.ts` | The one API call | no — fails to `null` |
| `agent.ts` | One pass over the live board | no |

**Every failure ends in a pass.** No key, a rate limit, a refusal, a truncated
response, unparseable JSON, a thin book, a window that locked mid-flight — all
of them produce no trade. Doing nothing is the default state, so there is no
failure mode where a broken forecaster trades badly.

### No floats, anywhere

The model returns **integer basis points**, never a decimal. A probability sits
directly beside a price in every comparison in `decide.ts`, so a float there
would violate CLAUDE.md hard rule 3 in the most consequential place in the
codebase. `scripts/lint-no-float-money.ts` was extended to scan
`packages/ai/src` for exactly this reason.

## Integrity

Three properties, each enforced by construction rather than by care:

1. **Outcomes come from the chain.** The `forecasts` table stores what the model
   asserted and why. It is never consulted to decide whether a call won — that
   is read from `calls`, which the indexer derives from chain fills, exactly as
   for every human player.
2. **Estimates are written once.** `recordForecast` is insert-or-ignore, not an
   upsert. A later pass cannot quietly improve a forecast after the market moved.
   The book at the moment of the estimate is stored alongside it, so the edge
   claim stays checkable once prices have moved on.
3. **The badge is server-side.** `isAi` is stamped by the standings route from
   the server's own configuration. A browser never gets to say who the
   forecaster is.

## Running it

```bash
# 1. Set the key and the wallet in .env (see the AI forecaster block there)
ANTHROPIC_API_KEY=sk-ant-...
AI_PRIVATE_KEY=0x...        # a burner; fund it with STT and tUSDC like any player

# 2. Prove it works. Dry run: reads live windows, calls the model, prints what
#    it WOULD do. Signs nothing, writes nothing.
pnpm ai:probe
pnpm ai:probe --asset ETH --count 3 --prompt
```

In production it runs off ordinary traffic, like ingestion — there is nowhere
free and reliable to host a daemon. `/api/ai/run` is poked by `KeepFresh`
alongside `/api/tick`.

Because that endpoint **spends** (API tokens and testnet collateral), its
throttle is stricter and lives in `sync_state` rather than in a module
variable: a serverless deployment runs many instances, and a per-instance lock
would let it trade N times as often as intended purely because traffic was
spread around. Floor is 150 seconds between runs, globally, with at most one
placement per run.

## Without a key

The site works exactly as it does with the forecaster running. The AI page says
it is offline; the per-window read renders nothing; the leaderboard has one
fewer player. Nothing degrades and nothing errors.

## What is deliberately not claimed

Short-horizon crypto direction is close to a coin flip, and the system prompt
says so to the model in as many words — the honest answer for most windows is
near 50%, and the market price is a strong prior made by people with money at
stake. This forecaster is **not** expected to print money. It is expected to be
*measured*, publicly, by the same yardstick as everyone else.

That is the whole idea. An AI that can lose in public is worth more than one
that cannot be checked.

## Not wired, on purpose

Server-side refusal fallbacks (`betas: ["server-side-fallback-2026-07-01"]`)
are **not** enabled. A price-direction forecast has essentially no refusal
surface, a refusal already degrades safely to a pass, and an untested beta
header in a demo hot path is a worse risk than the one it removes. If you want
it, add the beta and `fallbacks: "default"` to the request in `forecast.ts` and
verify with `pnpm ai:probe` before relying on it.
