# DreamDEX Event Contracts — integration feedback

From building **Prediction Leagues** against Shannon testnet, 28 Aug – 1 Sep 2026.
Everything below was hit in practice and is reproducible; findings verified by
trading are marked **[MEASURED]**. Offered in the spirit of "here is where the
next team will lose a day".

---

## What worked well

- **Runtime discovery is the right design.** `listBinaryVenueIds()` and
  `listBinaryAssets()` meant we never hard-coded a venue or a contract address.
  Six venues were live on Shannon; discovery handled all of them without a code
  change when ids moved.
- **The pure functions are the best part of the SDK.**
  `quoteBinaryStakeOverBook(book, side, stake, oneCollateral, {tickSize, lotSize})`
  is exported separately from the stateful quoting path. That single design
  decision let us keep the chain as the source of truth and still use the SDK's
  exact math — it is what rescued finding #1 below. **More of this, please.**
- **Client-side wallet signing is properly supported.** `buildPlaceOrder` returning
  an unsigned call is exactly what a consumer app needs; many venue SDKs assume
  you hold the key.
- **tUSDC is self-mintable**, so only STT needs the web faucet. This removed a
  large amount of onboarding friction — new users can fund themselves in-app.
- **[MEASURED] Settlement is fast enough for a live demo.** A 300s window read
  `status 4` (Resolved) on the first poll after expiry. We had budgeted for
  minutes and needed seconds.
- **Testnet produces VOIDs naturally**, which let us test void handling for real
  instead of simulating it. Genuinely useful.

---

## Sharp edges, worst first

### 1. `quoteBinaryStake()` returns `null` unless you are live-tailing **[MEASURED]**

The biggest trap we found. It resolves its book through `resolveLiveBinaryBook`,
which reads the SDK's reactive store — **empty without a subscription**. It
returns `null`, which is indistinguishable from *"no liquidity"*, while
`getBinaryOrderBook()` shows a full book one `eth_call` away.

Measured: every quote returned `null` against windows actively quoting 0.355 and
0.673. We spent hours believing the venue was empty.

`quoteBinaryOrder` and `quoteBinarySell` share the behaviour.

> **Suggestion:** throw `NotSubscribed` rather than returning `null`, or fall
> back to a chain read. A sentinel that means two opposite things is the one
> shape a caller cannot handle correctly.

### 2. A reverted write does not throw

SDK writes skip simulation and resolve even when the transaction reverted; the
receipt rides on `order.info`. Without an explicit `receipt.status === "reverted"`
check, failed orders sit as `PENDING` forever. Every integrator will write this
bug once.

> **Suggestion:** throw on revert by default, with an opt-out.

### 3. Approvals must cover `quantity`, not `escrow` **[MEASURED]**

A binary contract settles at up to 1.0 collateral, so the pool escrows against
the **contract count**, not the collateral committed. Approving the escrow
reverts with `ERC20InsufficientAllowance` (`0xfb8f41b2`).

This is not stated anywhere we could find, and it is genuinely counter-intuitive:
you approve 20.03 to spend 9.99. Worse, it only bites the *exact-approval* path —
the SDK's default `maxUint256` masks it entirely, so it appears the moment a team
does the more careful thing.

> **Suggestion:** document the basis explicitly, and consider offering an exact
> approval helper. See #4 for why `maxUint256` is not a safe default.

### 4. The default `maxUint256` approval triggers wallet phishing warnings

MetaMask flags an unlimited approval from a new domain as a possible drain. For a
consumer app whose first user action is connecting a wallet, that warning is
close to fatal — we watched it stop people at the door. We now build an exact
approval sized to the order.

> **Suggestion:** make exact approval the default for consumer flows.

### 5. `ImmediateOrCancelNoFill` arrives as a bare selector **[MEASURED]**

`0xd48c4403` with no decoded message. We initially matched on error text, which
silently misclassified the ordinary "the book was empty" case as a crash. Real
handling means walking the error `cause` chain for the raw selector.

> **Suggestion:** publish the selector table, or decode custom errors in the SDK.
> An IOC finding no fill is a *normal* outcome and should not look like a fault.

### 6. Settled markets leave the live list — and become unrecoverable

`loadMarkets()` / `listLiveBinaryMarkets()` cannot see finalized markets, so a
window whose entire lifetime passed while an indexer was down **cannot be
enumerated afterwards**. `status: "Finalized"` helps, but only within whatever
retention the indexer keeps.

For us this is permanent data loss: one user's call is unrecoverable. Any
integrator whose worker restarts will hit this.

> **Suggestion:** a `listBinaryMarkets({ closedAfter })` range query.

### 7. `getClaimable()` is an indexer read, and it fails **[MEASURED]**

A probe won, then died on `indexer Portfolio failed: fetch failed`, leaving real
winnings unredeemed. Winnings must never be stranded by an indexer blip.

After settlement the client already knows the `marketId` and which outcome it
holds, so redemption needs no indexer at all: `getMarketOnchain` +
`getOutcomeBalance` + `redeem`. We now redeem chain-first and only sweep via
`getClaimable` afterwards.

> **Suggestion:** document the chain-only redemption path — it is strictly more
> robust and not obvious from the API surface.

### 8. The Shannon indexer URL is undocumented

The markets-sdk README shows the **mainnet** indexer
(`prd.smk.somnia.host`). We found `dev.smk.somnia.host/v1/graphql` serving live
Shannon binary markets by probing. Nothing states it is the intended endpoint.

This is a one-line documentation fix that would have saved us most of a day, and
it is the single thing we would most like corrected before the next cohort.

### 9. A venue id is not a network signal

The id the bot kit labels "mainnet" (`0x458b30c2…`) is **also live on Shannon**.
Any team using venue id as a mainnet safety check would be wrong, and would not
find out until it mattered. We assert on chain id and collateral identity instead.

> **Suggestion:** call this out in the docs. It reads like a network discriminator.

### 10. Pools are recycled across windows

State must be keyed by `marketId`, never by pool address. Documented in the bot
kit, easy to miss, and corrupts your schema silently if you get it wrong — we
key our windows table on `marketId` for exactly this reason.

### 11. The question text format changed three times in a week **[MEASURED]**

Within hours, the same venue produced both:

```
"BTC closes at or above its opening price"
"Pricefeed test: will BTC/USDC's price be at or above 78041.36 at unix time 1788015300?"
```

Anything parsing this string will break. We treat it as opaque display text and
derive all semantics from structured fields.

> **Suggestion:** either freeze the format or state that it is not stable.

### 12. `examples/` in the bot kit is stale

It still shows `placeTakerOrderWithoutVault`, which has been removed. New
integrators start in `examples/`. We had to instruct ourselves in writing not to
read that directory.

---

## Smaller notes

- **[MEASURED] Takers pay the fill price, not the offered limit** — 0.534 paid on
  a 0.626 limit; 0.554 on 0.571. Correct behaviour, but it means a UI must show
  an *estimated* payout before the fill and a confirmed one after. Worth stating
  plainly for consumer builders.
- `expireTimestampNs` is mandatory and capped at the market's own expiry — easy to
  miss until an order is rejected.
- `amountToPrecision` floors small sizes to zero; size to the lot grid yourself.
- One key = one sender. Claiming signs from the same key as trading, so two
  senders race the nonce. Serialise, or use separate keys.

## What we would most like next

1. **The Shannon indexer URL, in the README.** One line, biggest single win.
2. **Delegated redemption for consumer apps.** Winnings are claimed, not received,
   so a winner must sign a *second* transaction. `signRedeemAuthParams` /
   `redeemFor` / `setOperatorApprovalForPool` appear in the typings and look
   exactly like the missing piece, but are undocumented. For a consumer product,
   "you won — now sign again to actually get paid" is the roughest edge in the
   whole flow.
3. **More exported pure functions.** `quoteBinaryStakeOverBook` is the model:
   stateless math over data the caller supplies. It is what let us keep the chain
   authoritative while still using your arithmetic.

---

*Filed by the Prediction Leagues team. Full working notes, with verification
status per claim, are in [`docs/dex-notes.md`](dex-notes.md); the residual
questions we could not resolve are in
[`docs/questions-for-telegram.md`](questions-for-telegram.md).*
