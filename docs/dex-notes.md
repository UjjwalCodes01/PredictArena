# docs/dex-notes.md — DreamDEX Event Contracts: verified ground truth

Written per CLAUDE.md ("if docs contradict AGENTS.md assumptions, record what you found and say so
explicitly") and PLAN.md Phase 0. **Verified live on 28 Aug 2026, ~17:26 UTC.**

Two confidence levels are used throughout:
- **[VERIFIED]** — I called the endpoint / read the chain / read the shipped package myself.
- **[DOCS]** — stated by official docs, not independently confirmed.

---

## 1. The headline: our REST/WS architecture does not apply to Event Contracts

AGENTS.md §3 and CLAUDE.md rules 4–5 assume Event Contracts are reachable through
`https://stg.api.dreamdex.io/v0` (REST) + `wss://.../v0/ws/public`, with contract addresses from
`GET /v0/markets`. **That is the spot CLOB API. It has no Event Contract surface.**

**[VERIFIED]** `GET https://stg.api.dreamdex.io/v0/markets` returns exactly 3 markets, all
`"kind":"spot"` — `SOMI:USDso`, `WBTC:USDso`, `WETH:USDso`. No binary/event rows.

**[VERIFIED]** Every plausible event path 404s:
`/v0/events`, `/v0/event-contracts`, `/v0/eventcontracts`, `/v0/markets/events`, `/v0/windows`,
`/v0/event/markets`, `/v0/predictions`, `/v0/binary-markets`.

**[DOCS]** docs.dreamdex.io states the HTTP API "covers spot only and has no event-contract endpoints".

### What Event Contracts actually use

| Layer | Real source |
|---|---|
| SDK | **`@somnia-chain/markets-sdk`** (npm, v0.28.1, published 2026-08-21) |
| Market/window data | **Envio/Hasura GraphQL indexer**, testnet: `https://dev.smk.somnia.host/v1/graphql` |
| Chain reads/writes | Somnia RPC / WS — `wss://dream-rpc.somnia.network/ws` |
| Addresses | `SOMNIA_TESTNET_ADDRESSES` exported by the SDK |

**[VERIFIED]** `https://dev.smk.somnia.host/v1/graphql` responds to introspection and serves live
BTC/ETH binary markets. The production (mainnet) indexer is `https://prd.smk.somnia.host/v1/graphql`
— **do not point at that one.**

**Consequence for `packages/dex`:** it wraps `@somnia-chain/markets-sdk` + the testnet indexer, not
`fetch()` against `stg.api.dreamdex.io`. The "all DreamDEX I/O behind `packages/dex`" rule survives
intact; only the transport underneath changes.

---

## 2. Collateral is tUSDC (6 decimals) on testnet — NOT USDso

Every planning doc says users stake **USDso**. On Shannon that token does not exist.

**[VERIFIED] on-chain** at `0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E` via `dream-rpc.somnia.network`:

```
name()     = "Test USDC"
symbol()   = "tUSDC"
decimals() = 6
```

**[VERIFIED]** The mainnet USDso address `0x00000022dA000002656c64D9eA6011ea952D008A`
(18 decimals) returns `eth_getCode = 0x` on testnet — no contract.

**Action:** all UI copy says **tUSDC**; all money math uses **6 decimals**. Stake presets of
1 / 5 / 10 tUSDC are `1_000_000n / 5_000_000n / 10_000_000n`. Do not hard-code 18.

### tUSDC is self-mintable — only STT needs the web faucet

**[VERIFIED]** The tUSDC contract exposes `faucet(uint256)` (selector `0x57915897`, confirmed
present in the deployed bytecode), surfaced by the SDK as `trader.faucet({ amount })` and defaulting
to 10,000 tUSDC. Any wallet holding STT for gas can mint its own stake.

This matters for the demo: PLAN.md's risk register lists "testnet faucet dry / STT scarce" as a
medium risk needing 4 hand-funded wallets. **Half of that risk is gone** — only STT is externally
gated. `pnpm faucet` funds the seed wallets' collateral in one command.

> Note the SDK's `TraderConfig.decimals` **defaults to 6**, which happens to be correct for testnet —
> but set it explicitly rather than relying on the default.

---

## 3. It is an order book, not a fixed-payout bet

resource.md describes "Correct call = fixed payout". The real mechanism is a CLOB over probabilities.

- **[DOCS]** Up and Down trade on a **single** order book quoted in Up terms; a Down price is always
  `1 − up price`. Prices are probabilities in `(0, 1)`.
- **[DOCS]** A winning contract redeems for **1 unit of collateral**; you pay `price` for it. So the
  payout is *fixed at 1*, but the **entry price is market-driven** — the effective odds move.
- **[DOCS]** On a **void**, both sides redeem **0.5 each**, no fee. "A refund, not a loss."
- **[VERIFIED]** Outcome index: `0 = Up`, `1 = Down`.

**Consequence:** the UI cannot show a single static payout number. It must read the book
(`fetchOrderBook`) and show an implied payout from the best ask at click time. Our stake presets are
in collateral, so quantity = stake / price — quantized to the venue's lot grid.

### Status enum (**[DOCS]**, market-structure page)

```
Listed (0) → Trading (1) → Locked (2) → Resolved (4) | Voided (5)
```

Only status **1 (Trading)** accepts orders. This maps cleanly onto our
`PENDING | WON | LOST | VOID | FAILED` position enum — keep them distinct, though: market status is
not position status.

---

## 4. Live testnet reality (**[VERIFIED]**, 28 Aug 2026 17:27 UTC)

Queried `Market` on the testnet indexer, `marketType: "BINARY"` (enum is **uppercase**):

```
ETH  int=86400s  exp=+392.5m  Trading    ETH  int=300s  strike=244266  exp=+2.5m  Trading
BTC  int=86400s  exp=+392.5m  Trading    BTC  int=300s  strike=7793085 exp=+2.5m  Trading
BTC  int=14400s  exp=+152.5m  Trading    ETH  int=60s   exp=+0.5m      Trading
ETH  int=14400s  exp=+152.5m  Trading    BTC  int=60s   exp=+0.5m      Trading
ETH  int=3600s   exp=+32.5m   Trading    ETH  int=60s   exp=-0.5m      Finalized win=1
BTC  int=3600s   exp=+32.5m   Trading    BTC  int=60s   exp=-0.5m      Finalized win=1
```

Confirmed facts:
1. **BTC and ETH windows are live now.** The product is buildable today.
2. **Multiple concurrent durations per asset: 60s, 300s, 1h, 4h, 24h.** Our specs assume one generic
   "window". The UI must pick a series — **recommend the 5-minute (300s) series** for the demo: fast
   enough that a settlement lands inside a 2–3 min video, slow enough to place a call deliberately.
3. **Settlement is fast** — a window expiring 30s ago already reads `Finalized`. Our "≤60s to flip
   status" target is achievable; a 45s reconciliation poll is well-matched.
4. `question` text reads: `"ETH closes at or above its opening price"`. **Do not parse it** — read
   `strike` and `intervalSec`. (Wording has changed several times.)
5. `strike` is `0` on longer windows not yet opened, and populated once the window opens.
6. `tickSize` / `lotSize` / `minQuantity` are **null on the indexer** — read them from chain with
   `getBinaryBookParams(pool)`.

### VOID is common on testnet — this de-risks PLAN.md's void testing

**[VERIFIED]** Recent voided 60s windows for both BTC and ETH (expiries 1787931720/1787931780/
1787931840, ~1.7h before the check), all `voidPolicy: 0`.

PLAN.md's risk register lists "Void/edge outcomes unreproducible for testing — Medium". **Downgrade
it: voids are readily reproducible on the 60s series.** The flip side is that the demo can hit a
void live, so the "Voided — stake returned" UI is demo-critical, not defensive polish.

---

## 5. venueId — a required config our specs never mention

**[VERIFIED]** `client.listBinaryVenueIds()` returns **six** live venues on Shannon, one per
operator:

```
operator 1  0xcc69885fda6bcc1a4ace058b4a62bf5e179ea78fd58a1ccd71c22cc9b688792f
operator 2  0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c  ← bot kit's "testnet" id
operator 3  0xcbc4e5fb02c3d1de23a9f1e014b4d2ee5aeaea9505df5e855c9210bf472495af
operator 4  0x1a1e6821cde7d0159c0d293177871e09677b4e42307c7db3ba94f8648a5a050f
operator 5  0x458b30c2d72bfd2c6317304a4594ecbafe5f729d3111b65fdc3a33bd48e5432d  ← bot kit's "MAINNET" id
operator 6  0x697b2bd7bb2984c4e0dc14c79c987d37818484a62958b9c45a0e8b962f20650f
```

Two things follow, and both matter:

1. The bot kit documents one testnet venue and one mainnet venue. **Its "mainnet" id is live on
   testnet.** A venue id therefore tells you nothing about which network you are on — do not use one
   as a safety check. The chain id and the collateral token are the only guards (§7).
2. **`listBinaryVenueIds()` exists**, so venue discovery needs no hard-coded constant at all. This
   fully resolves the "which VENUE_ID do we pin" question: pin nothing.

**Action:** `VENUE_ID` in `.env` is optional and empty by default; `packages/dex` discovers venues at
runtime. Same spirit as CLAUDE.md rule 5, applied to a field the rule did not foresee.

### Series are per-venue, and they roll

**[VERIFIED]** Live series map, read twice ~40 minutes apart:

```
BTC/ETH     60s  venue 0x1a1e6821…   (operator 4)
BTC/ETH    300s  venue 0x1a1e6821…   (operator 4)
BTC/ETH   3600s  venue 0x679795a0…   (operator 2)
BTC/ETH  14400s  venue 0x679795a0…   (operator 2)
BTC/ETH  86400s  venue 0x679795a0…   (operator 2)
```

The short series (60s, 300s) and the long series (1h+) are run by **different operators**. On one
read the 300s series was momentarily absent and reappeared minutes later — series roll, so "is the
300s window live" is a question to ask at runtime, never an assumption to bake in. `pnpm doctor`
prints this map on every run.

**Demo implication:** the 300s (5-minute) series remains the right pick — short enough to settle
inside a 2–3 minute video, long enough to place a call deliberately — but the UI must degrade to
whatever is live rather than assuming a series exists.

---

## 6. Client-side wallet signing IS supported

AGENTS.md's signing model (user's browser wallet signs; server never holds keys) was at risk because
every doc example passes `privateKey`. It is fine.

**[VERIFIED]** from the shipped typings (`dist/unified/exchange.d.ts`):

```ts
export type SomniaMarketsConfig = ClientConfig &
  Pick<TraderConfig, "privateKey" | "account" | "walletClient">;
```

and `TraderConfig`:

```ts
/** A pre-built signer (e.g. a browser/wagmi wallet over an injected provider). */
walletClient?: WalletClient;
```

There is also `trader.buildPlaceOrder(params)` which returns an **unsigned** order plus an optional
`approval` step — exactly the shape `placeCall()` needs to hand a tx to the browser wallet, and it
confirms the **approval-if-needed pre-step** AGENTS.md predicted is real.

---

## 7. Addresses (**[VERIFIED]** from SDK `dist/addresses.js` + on-chain code check)

`SOMNIA_TESTNET_ADDRESSES`:

| Key | Address |
|---|---|
| binaryModule | `0x3ecC694Cef705358864a646142ac17A90E29e388` |
| binaryPoolImpl | `0x82A1FcdaA2daC2fC7D5f9909D43E68021eE966FD` |
| binarySettlement | `0xbF4a49e0Dfd092e5FBE8E5761064C49533e6Ed23` |
| clobFactory | `0xb2BE8EE02F96379DB75f01802384593EBa9bfF04` |
| collateral / testUsdc | `0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E` |
| collateralRouter | `0xbC0C9834B15ACE38bB50dDaa7d7f7C7CC4DC183C` |
| marketCreator | `0x138CfA6b80475b8c03d7E468b2442278E51e645a` |
| marketCreatorFactory | `0xE6bEE93cE87c9E6e62aCb621caa7832EE47b4F6B` |
| marketsCore | `0x2802504314685D89bF6C992CA5a8e7cC78bc0294` |
| oracleHub | `0xe40db387cC98601Dd11bd634fF2f3AD5686dE32b` |

All confirmed to have bytecode on Shannon.

### ⚠️ Mainnet safety: addresses alone cannot protect us

**[VERIFIED]** 8 of these 11 addresses are **byte-identical on mainnet** (CREATE3 deployment). Only
`collateral`/`testUsdc` and `marketCreator` differ.

CLAUDE.md rule 1 says "testnet only". An address allowlist is therefore **useless as a guard**. The
only real protections are:
1. `chainId === 50312` asserted before every write, and
2. `collateral === 0x70a86D…5d8E` (tUSDC) asserted at client construction, and
3. never configuring `prd.smk.somnia.host` or `api.infra.mainnet.somnia.network`.

Recommend all three as hard assertions in `packages/dex`, not just config.

---

## 8. Sharp edges to design around (from the bot kit's `docs/event-contracts.md`)

The bot kit ships an entire Event Contract half our specs don't mention: `strategies/ec-*`
(`ec-starter`, `ec-maker`, `ec-passive`, `ec-settlement`, `ec-oracle-follow`, `ec-laddering-bot`),
`docs/event-contracts.md`, and `scripts/ec-doctor.ts`. Use `ec-doctor.ts`, not `doctor.ts`.

1. **Winnings are claimed, not received.** A settled market pays only when someone redeems. A user
   who wins and never claims sees a near-zero wallet. **This is a product decision our specs never
   made** — see the open question in `docs/questions-for-telegram.md`.
2. **A reverted write does not throw.** SDK writes skip simulation and resolve even when the tx
   reverted; the receipt rides on `order.info`. Must check `receipt.status === "reverted"` explicitly
   or we will mark losing/failed orders as `PENDING` forever. Directly affects our `FAILED` handling.
3. **Gate on on-chain status, not the indexer.** The indexer lags seconds. Only status `1` accepts
   orders. This is exactly AGENTS.md's "re-check window state at click time" — now with a mechanism.
4. **Float prices break on 18-decimal venues** (`parseUnits(price.toFixed(18))` drifts off the tick
   grid → `InvalidPrice`). Testnet is 6-decimal so it looks clean — but this reinforces CLAUDE.md
   rule 3: integers in tick/lot units, never floats.
5. **Order expiry (`expireTimestampNs`) is mandatory**, capped at the market's own expiry.
6. **Size to the lot grid yourself**; the generic `amountToPrecision` floors small sizes to zero.
7. **`loadMarkets()` cannot find winnings** — settled markets leave the live list. Use
   `client.listBinaryMarkets({ venueId, status: "Finalized" })`.
8. **Pools are recycled across windows** — key all state by `marketId` or symbol, **never** by pool
   address. Our DB schema must use `marketId` as the window key.
9. **One key = one sender.** Claiming signs from the same key as trading; two senders race the
   nonce. Serialise the demo-seed wallet's txs (matches AGENTS.md's nonce guidance).

---

## 9. Endpoints that ARE correct in our specs (**[VERIFIED]**)

| Item | Value | Status |
|---|---|---|
| Shannon chain ID | 50312 | ✅ `eth_chainId` → `0xc488` |
| Shannon RPC | `https://dream-rpc.somnia.network` | ✅ live, block `0x1c3b4529` |
| Mainnet chain ID | 5031 | ✅ `0x13a7` (documented for avoidance only) |
| stg REST | `https://stg.api.dreamdex.io/v0` | ✅ live — but **spot only** |
| stg WS | `wss://stg.api.dreamdex.io/v0/ws/public` | ✅ live (HTTP 426 upgrade-required) — **spot only** |

The network table in AGENTS.md §3 / resource.md §2 is accurate; it is simply the *wrong API* for
Event Contracts.

---

## 10. Rate limits, auth, and gas

**Rate limits / auth (**[DOCS]** + **[VERIFIED]** by use):**
- The docs state plainly: *"There are no API rate limits: market data is the chain itself, and the
  public RPC endpoints are unthrottled."*
- **No API key or auth header** is needed for reads. The SDK's `ClientConfig.indexerHeaders` exists
  only for privileged server-side Hasura roles (e.g. `_aggregate` fields the public role hides) and
  **must never be set in a browser client**.
- Writes authenticate by signature alone — there is no account/session concept to register.
- Practical caution: this removes the need for the request queue AGENTS.md §5 specifies for the
  *spot* REST API, but per-market chain reads in a loop are still the slow path. Cache market
  metadata; batch where the SDK allows.

**Gas (STT) expectations (**[VERIFIED]** from the SDK's shipped constants):**
- `DEFAULT_GAS = 10_000_000n` — gas is **never estimated**; every SDK-signed write sends a fixed 10M
  ceiling. The docstring notes Somnia's gas schedule is dear enough that even an ERC-20 `approve`
  runs out under a 1M limit.
- `DEFAULT_FEES` = 60 gwei ceiling, zero tip.
- 10M × 60 gwei ⇒ a **~0.6 STT envelope per transaction**. The unused remainder is not charged, but
  **the mempool only admits a transaction whose ceiling is funded on top of its `value`.**
- Consequence for our UI: "insufficient gas" must trigger at roughly **0.6 STT**, not at zero. A
  wallet holding 0.1 STT looks funded to a naive check and will still be refused. `pnpm doctor` and
  `pnpm place-one` both use the 0.6 STT threshold.

---

## 11. Phase 0 toolkit in this repo

| Command | What it does |
|---|---|
| `pnpm wallets` | Generates 4 burner wallets into `.env` (mode 600). Refuses to overwrite funded ones without `--force`; refuses to run at all unless `.gitignore` excludes `.env`. |
| `pnpm faucet` | Mints tUSDC to the burners via the collateral contract's own `faucet(uint256)`. Needs STT already present. `--slot`, `--amount`. |
| `pnpm doctor` | Read-only. 20 checks: safety rail, chain, collateral identity, contract bytecode, indexer reachability + lag, venue discovery, live series map, window selection, book params, liquidity, wallet balances, unclaimed winnings. Signs nothing. |
| `pnpm place-one` | The exit gate. Places ONE real order, verifies the receipt, polls to settlement, redeems, writes `artifacts/phase0-probe.json`. Supports `--dry-run`, `--claim-only`, `--side up\|down`, `--asset`, `--interval`, `--yes`. |
| `pnpm gate` | Verifies all three Phase 0 exit-gate conditions against reality. |

Shared code lives in `scripts/lib/` (`config.ts`, `dex.ts`, `money.ts`, `log.ts`) and is written to
be **promoted into `packages/dex` in Phase 1** rather than thrown away.

---

## 12. Open questions → `docs/questions-for-telegram.md`

Recorded there rather than guessed, per CLAUDE.md. Phase 0 answered three of the original six:
- **Q1 (indexer URL)** — `https://dev.smk.somnia.host/v1/graphql` confirmed working for Shannon.
  Still worth confirming it is the *intended* endpoint and stable through 8 Sep.
- **Q3 (venueId)** — resolved: `listBinaryVenueIds()` discovers them; pin nothing.
- **Q6 (price feed)** — the SDK exports `SOMNIA_TESTNET_PRICE_FEED` and `client.fetchPrice()`, so a
  live underlying price is available on testnet without extra infrastructure.

Q2 (delegated redemption), Q4 (`intervalSec` reliability) and Q5 (void causes) remain open.

---

## 13. Measured end-to-end — the Phase 0 probe (29 Aug 2026)

**[VERIFIED]** Two real orders placed, settled and reconciled on Shannon by `pnpm place-one`.

| | Probe 1 | Probe 2 |
|---|---|---|
| Asset / series | BTC 60s | ETH 300s |
| Side | Up | Up |
| Limit price | 0.626 | 0.571 |
| **Actual fill** | **0.534** | **0.554** |
| Contracts | 1.5970 | 1.7510 |
| Escrow | 0.9997 tUSDC | 0.9998 tUSDC |
| Settled | 25s after placement | ~2s after expiry |
| Outcome | LOST (Down won) | **WON** |
| Payout | — | **+1.7510 tUSDC** (exact) |

- Order tx (won): `0x0b50ef59e3ffcc0aa4b600d346e0c4c9d342af3a08c1b26b9a21d81568d54836`
- Redeem tx: `0x7163316bb86ec4d36912de7c33a7788bcb982cf2fcb9cb4ed61a987a827cd303`
- Balance moved 9998.1771 → 9999.9281 tUSDC, matching the 1.7510 payout to the unit.

**This satisfies Phase 0 exit-gate item 2.** `pnpm gate` re-verifies it against the chain.

### Findings that only surfaced by actually trading

**1. `client.quoteBinaryStake()` silently returns `null` unless you are live-tailing.** ⚠️ The
biggest trap found so far. It resolves its book through `resolveLiveBinaryBook`, which reads the
SDK's reactive store — empty with no subscription. It returns `null`, which is indistinguishable
from "no liquidity", while `getBinaryOrderBook()` shows a full book one `eth_call` away. Measured:
every quote returned null against windows quoting 0.355 / 0.673.

> **Fix used:** read the book from chain and run the SDK's *exported pure* function over it —
> `quoteBinaryStakeOverBook(book, side, stake, oneCollateral, { tickSize, lotSize })`. Same math,
> and the chain stays the source of truth. See `quoteStakeOnChain()` in `scripts/lib/dex.ts`.
> The same caveat applies to `quoteBinaryOrder` and `quoteBinarySell`.

**2. Takers pay the fill price, not the price they offered** — confirmed twice (0.534 paid on a
0.626 limit; 0.554 on 0.571). The bot kit says the same. The UI must therefore show an *estimated*
payout from the book, and the confirmed payout only after the fill.

**3. Settlement is fast enough for a live demo.** Probe 2 read `status 4` (Resolved) on the first
poll after expiry — within the 5s poll interval. A 45–60s reconciliation loop is comfortable.

**4. `getClaimable()` is an indexer read and does fail.** Probe 2 won and then died on
`indexer Portfolio failed: fetch failed`, leaving the winnings unredeemed. Winnings must never be
stranded by an indexer blip: after settlement we already know the `marketId` and which outcome we
hold, so redemption needs no indexer at all — `getMarketOnchain` + `getOutcomeBalance` + `redeem`.
`place-one` now redeems chain-first and only then sweeps via `getClaimable` (with one retry).

**5. The question text changed format again.** Probe windows read
`"Pricefeed test: will BTC/USDC's price be at or above 78041.36 at unix time 1788015300?"`, where an
hour earlier the same venue produced `"BTC closes at or above its opening price"`. Third distinct
wording observed. **Never parse it** — read `strike` and `intervalSec`.

**6. Liquidity is intermittent and gaps at every window roll.** Two runs failed with a correct
`NO_LIQUIDITY` in the seconds after a series rolled, then succeeded a minute later. Window selection
must check the book per window *and* per side, not just pick the one with the most time left — and
the UI needs a real "no quotes right now" state, not a spinner. `pnpm survey` shows the live picture.
