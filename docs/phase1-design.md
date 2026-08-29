# Phase 1 design — `packages/dex`

PLAN.md Phase 1 was written before Phase 0 measured the real API surface. The **intent** of every
bullet is kept; three implementations change because the assumed transport does not exist. Flagged
here rather than silently reconciled, per AGENTS.md ("when the docs conflict with this file, the
docs win — flag the conflict").

## Deviations from PLAN.md Phase 1, and why

| PLAN.md says | Reality (docs/dex-notes.md) | What we build |
|---|---|---|
| `getPositions` / `getSettlement` — "REST reads" | `stg.api.dreamdex.io` is spot-only; no event-contract REST exists | Chain reads (`getMarketOnchain`, ERC-6909 balances) with the indexer as an accelerator, never as the source of truth |
| `subscribe(topics, onEvent)` — "WS with auto-reconnect" | The spot WS carries no event-contract topics | SDK live tail over the chain WS, wrapped in the same backoff/resubscribe contract, **plus** a polling reconciler — polling is the guarantee, the tail is the optimisation |
| `placeCall({… stakeWei})` | Collateral is tUSDC at **6** decimals, not 18 | Same shape, field named `stake` — `bigint` in collateral base units. "Wei" would invite an 18-decimal assumption |
| `getMarkets()` — "contract addresses + token decimals" | Addresses ship in the SDK; 8 of 11 are identical on mainnet | Still never hard-coded, but the safety check is chain id + collateral identity, since addresses cannot distinguish networks |

Everything else — the `DexError` code set, the TTL cache, the request queue with jittered retry,
`bigint` everywhere — is built as written.

## `placeCall` — states and edge cases handled

CLAUDE.md requires these enumerated before implementation for anything touching order placement.

| # | Condition | Code | Detected |
|---|---|---|---|
| 1 | RPC is not Shannon 50312 | `CHAIN_MISMATCH` | before signing |
| 2 | Window not `Trading` on-chain | `WINDOW_CLOSED` | before signing, re-checked immediately before send |
| 3 | Too little time left for the order to live | `WINDOW_CLOSED` | before signing |
| 4 | No resting asks on the chosen side | `NO_LIQUIDITY` | before signing |
| 5 | Stake buys less than the venue minimum | `INSUFFICIENT_STAKE` | before signing |
| 6 | Collateral balance below the escrow | `INSUFFICIENT_STAKE` | before signing |
| 7 | STT below the funded gas ceiling (~0.6) | `INSUFFICIENT_GAS` | before signing |
| 8 | ERC-20 allowance short | `NEEDS_APPROVAL` | returned as a pre-step, not an error |
| 9 | Transaction reverted | `ORDER_REJECTED` | receipt inspected — **the SDK does not throw** |
| 10 | FOK order filled nothing | `ORDER_REJECTED` | fills inspected |
| 11 | Same call submitted twice | — | idempotency key on `userData`, derived from (wallet, marketId) |
| 12 | Indexer unreachable | `API_DOWN` | falls back to chain reads |
| 13 | Rate limited / 5xx | `RATE_LIMITED` | queue retries with jittered backoff |

Position status is the enum `PENDING | WON | LOST | VOID | FAILED`. Booleans for outcomes are
forbidden (CLAUDE.md).

## Workspace scope

`packages/dex` and `scripts/` are built now. `apps/web`, `apps/indexer` and `packages/db` are
**deliberately not scaffolded as empty stubs** — a placeholder `apps/web` would make `pnpm dev` fail
in a confusing way and adds dead directories to a repo judges read. They arrive with the phase that
fills them (Phase 2 for the indexer and db, Phase 3 for web). The workspace glob already covers
`apps/*`, so adding them is a one-directory change.


---

## What shipped

```
packages/dex/src/
  index.ts        the public surface — nothing else may import the SDK
  config.ts       network constants + the testnet-only rail
  client.ts       createDexClient / assertLiveNetwork
  markets.ts      getMarkets, TTL-cached, venue discovery at runtime
  windows.ts      getWindows / getCurrentWindow, on-chain gated
  orders.ts       quoteCall, preflightCall, prepareCall, placeCall
  positions.ts    getSettlement, getPositions, redeem, awaitSettlement
  subscribe.ts    live updates with backoff + reconciliation
  money.ts        bigint money, formatting only at the display edge
  queue.ts        bounded concurrency + jittered retry
  time.ts         chain-corrected clock
  __tests__/      72 tests across money, safety, queue, clock, outcomes
```

`scripts/` was migrated onto the package and its private copies deleted, so
CLAUDE.md rule 4 ("all DreamDEX I/O goes through `packages/dex`") is now true
rather than aspirational — `pnpm gate` asserts it by grepping for direct SDK
imports.

## Exit gate result

`pnpm smoke` completed a live round-trip on Shannon, twice:

| Run | Asset | Fill | Settled | Outcome | Redeem |
|---|---|---|---|---|---|
| 1 | BTC 300s | 1.0270 @ 94.9% | 123s | **WON** | +1.0270 tUSDC |
| 2 | BTC 300s | 3.7170 @ 20.5% | 273s | LOST | n/a (no claim on a loss) |

A LOST outcome is still a PASS: the gate is a completed round-trip, not a
winning bet. Run 1 also captured the full status transition — 1 Trading → 2
Locked → 4 Resolved — confirming the enum in dex-notes §3.

CI runs typecheck, lint (including the no-float-money rule), unit tests, and two
repo assertions: no secrets in tracked files, and no mainnet endpoint outside
the guard code. Everything in CI is offline, so testnet weather cannot turn it
red.

## New finding during Phase 1

**A third asset appeared.** `getMarkets()` returned `BTC, DECEDO, ETH` — the
asset list is not the fixed pair the specs assume. Nothing hard-codes it (the
UI will render whatever `getMarkets()` reports), but the demo should stay on
BTC/ETH, where liquidity is consistent.
