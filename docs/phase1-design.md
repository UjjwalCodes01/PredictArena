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

| Run | Asset | Fill | Settled | Outcome | Order tx |
|---|---|---|---|---|---|
| 1 | BTC 300s | 1.0270 @ 94.9% | 123s | **WON**, +1.0270 tUSDC | `0xa417c983…efca61e` |
| 2 | BTC 300s | 3.7170 @ 20.5% | 273s | LOST (no claim on a loss) | `0xdaeb6ec0…c42b3fde` |

Redeem for run 1: `0x3f54dfce…32b58460`. All three verified present and successful on-chain.

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


---

## Implementation audit

A pass specifically for hardcoded or unverified values. Three real problems, all fixed.

### 1. The collateral symbol was displayed but never verified ⚠️

`COLLATERAL_SYMBOL = "tUSDC"` was a constant, and `assertLiveNetwork()` read the symbol from the
token contract **but only compared the decimals**. So `client.collateral.symbol` returned the
hardcoded string no matter what was actually deployed — every balance in the CLI (and later the UI)
would have been labelled `tUSDC` even if the chain disagreed. That is showing the user something the
chain never confirmed.

Fixed: the constants are renamed `EXPECTED_COLLATERAL_*`, a mismatch on **either** symbol or
decimals is now fatal, and after verification the client carries the chain's own values. Confirmed
live: `chain 50312, collateral tUSDC (6 dp)` — both now read, not assumed.

### 2. The gas ceiling was a magic number

`GAS_CEILING_WEI = 600_000_000_000_000_000n` was correct but frozen. It is now derived —
`SDK_DEFAULT_GAS * DEFAULT_FEES.maxFeePerGas` — from the SDK's own exported fee config, so it tracks
the SDK instead of silently going stale. The 10M gas limit is the one number the SDK documents but
does not export at runtime, so it is mirrored and pinned by a test.

### 3. The Phase 1 gate grepped for names instead of importing

The gate checked `index.ts` for the strings `"getPositions"`, `"subscribe"` and so on. Those names
appeared in the gate's own required-list literal — so the check could pass on a package that
exported neither. Worse, five exports (`getCurrentWindow`, `prepareCall`, `getPositions`,
`subscribe`, `invalidateMarkets`) had **never executed**: they typechecked and nothing more.

Fixed two ways. The gate now imports the module and asserts each entry point is callable. And
`pnpm verify-api` runs all 16 exports against live Shannon, writing
`artifacts/verify-api.json` as evidence the gate then requires.

That run also produced a genuine finding: `preflightCall` reported **allowance SHORT — approval
pre-step required**, and `prepareCall` correctly returned an approval alongside the unsigned order.
The `NEEDS_APPROVAL` path AGENTS.md predicted is real and works.

### What the audit confirmed was already sound

- **One** hardcoded address in the whole codebase: the mainnet collateral, which exists only to be
  refused. Every other address comes from the SDK.
- **No venue id is pinned anywhere** — they are discovered at runtime. The six documented in
  dex-notes §5 were re-checked against the live indexer and all six are still serving.
- No mock, stub, placeholder or TODO in `packages/dex` or `scripts/`.
- Every tx hash cited in the docs was re-fetched from the chain: all present, all `status=success`.
- No silent fallback fabricates a value. The `?? 0` cases are interval defaults feeding
  `headroomSecFor`, which clamps to a conservative 15s — a safe default, not invented data.

### Still unverified, and honestly so

- **The VOID redemption path.** `redeem()` handles a void, and `getPositions` prices it at 0.5 per
  contract per the docs, but no void has been redeemed on-chain here. Voids are common on the 60s
  series, so this is testable — it just has not happened yet.
- **`prepareCall` produces an unsigned transaction that has never been signed by a browser wallet.**
  It builds correctly and carries the approval step; the wagmi round-trip belongs to Phase 3.
- **`subscribe` has been exercised only through a forced `reconcile()`**, not across a real
  disconnect. The backoff curve is unit-tested; the reconnect behaviour under a live socket drop is
  a Phase 4 resilience drill.


---

## Phase 1 re-check

A second pass against PLAN.md's literal wording rather than my own summary. Four more real defects.

### 4. CI would have failed on its own assertion 🔴

The exit gate is "`pnpm smoke` passes **and CI green**". Replaying the workflow locally, the
`Assert no mainnet configuration` step **failed**: it `git grep`ed for mainnet hostnames and hit
`.env.example`, where those hosts appear in comments explaining that they are rejected. The check
could not tell a warning from a setting.

Fixed by moving it into a comment-aware `scripts/lint-no-mainnet.ts` that runs as part of
`pnpm lint`. CI replayed clean afterwards in 12s, well inside the 2-minute budget.

### 5. Both linters were blind to URLs 🔴

`lint-no-mainnet` reported clean with `https://api.infra.mainnet.somnia.network` sitting in a file.
The comment stripper ran `line.replace(/\/\/.*$/, "")` — and `https://` **contains** `//`, so the
URL was truncated to `https:` and the host disappeared before the check ever saw it. A safety check
that silently cannot see the thing it guards against is worse than no check.

Fixed with a negative lookbehind (`/(?<!:)\/\/.*$/`) in both linters, and verified by planting a
real violation of each kind.

### 6. `NEEDS_APPROVAL` was a dead code

PLAN.md lists it among the required `DexError` codes. It existed in the union and in one comment,
and was never thrown — `placeCall` always passed `autoApprove: true`, so a short allowance was
silently approved.

That is wrong for the web app: AGENTS.md §5 wants an explicit Approve step in the UI, not an
unexplained second wallet prompt. `CallRequest` now takes `autoApprove` (default true), and with it
`false` a short allowance raises `NEEDS_APPROVAL`. Confirmed live — the DEV wallet's allowance was
genuinely short and the code fired.

### 7. `getPositions(address)` did not exist as specified

PLAN.md specifies `getPositions(address)`. The implementation required the caller to pass
`marketIds`, so there was no way to answer "what does this wallet hold?" from an address alone.

`marketIds` is now optional: omitted, the markets are discovered via `getClaimable(account)` and
then verified on-chain. The explicit path is kept because it needs no indexer at all, and an indexer
failure on the discovery path raises `API_DOWN` rather than returning an empty list that would read
as "you have no positions".

## Honest scorecard

| PLAN.md Phase 1 | State |
|---|---|
| pnpm workspace | **Partial** — `packages/dex`, `scripts`, `docs` exist; `packages/db`, `apps/web`, `apps/indexer` deliberately deferred to the phases that fill them |
| First commit of AGENTS/CLAUDE/.env.example/.gitignore | **Already committed** by the repo owner; this phase's work is **uncommitted** |
| CI: typecheck + lint + tests, under 2 min | **Written and replayed locally in 12s** — but it has never actually run on GitHub |
| `packages/dex` full API | **Done** — 16/16 exports executed against live Shannon |
| `DexError` codes | **Done** — all 8 present and all reachable |
| Request queue, jittered retry, bigint | **Done**, unit-tested |
| `scripts/smoke.ts` | **Done** — two live round-trips |
| Exit gate: smoke exits 0 | **Met** |
| Exit gate: CI green | **Not provable until it runs on GitHub** |
