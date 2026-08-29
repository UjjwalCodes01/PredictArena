# Questions for the hackathon Telegram

Per CLAUDE.md: write the exact question, move on, don't guess-and-bury.
Group link: https://t.me/+XHq0F0JXMyhmMzM0

Context gathered in `docs/dex-notes.md` (verified 28 Aug 2026). These are the residual ambiguities
that block a clean design decision.

---

### Q1 — Which testnet indexer URL is canonical, and is it stable for the hackathon? ⬅️ highest priority
> **Partly answered in Phase 0.** `https://dev.smk.somnia.host/v1/graphql` is verified working for
> Shannon: it serves live BTC/ETH binary markets and reports a sync lag of ~0 blocks. What remains
> is confirmation that it is the *intended* endpoint and will stay up through 8 Sep.
The markets-sdk README shows the mainnet indexer (`https://prd.smk.somnia.host/v1/graphql`). By
probing I found `https://dev.smk.somnia.host/v1/graphql` serving live Shannon binary markets, but no
doc states it. Is `dev.smk.somnia.host` the intended Shannon endpoint for the hackathon, and will it
stay up through 8 Sep? Is there a status page?

**Blocks:** the entire read path. Assumption used meanwhile: `dev.smk.somnia.host`.

---

### Q2 — Should a consumer app auto-redeem on the user's behalf, or is redemption always a second signature?
`docs/event-contracts.md` says winnings are claimed, not received — bots call `maybeClaim` on a loop
with their own key. In our app the user signs client-side and we hold no user key, so a winner must
sign a **second** transaction to actually receive their payout.

Is there a delegated/operator path (`setOperatorApprovalForPool`, session keys, `redeemFor` +
`RedeemAuthorization` — all of which appear in the SDK typings) that lets a frontend redeem on a
user's behalf **without** custody of their key? `signRedeemAuthParams` / `redeemFor` look exactly
like this, but they're undocumented.

**Blocks:** whether the demo shows "You won 12.4 tUSDC — Claim" (extra tap, honest) or a silent
sweep. Assumption used meanwhile: explicit user-signed Claim button.

---

### Q3 — ✅ ANSWERED IN PHASE 0 — no longer blocking
> `client.listBinaryVenueIds()` enumerates venues at runtime, so nothing needs pinning. Six venues
> are live on Shannon (operators 1-6), and the id the bot kit labels "mainnet"
> (`0x458b30c2…`) is among them **on testnet** — so a venue id is not a network signal and must not
> be used as a safety check. Kept below for the record; still worth asking which venue the
> organisers consider canonical for judging.

### Q3 (original) — Which venueId should hackathon projects target, and what is the stable way to discover it?
`docs/event-contracts.md` gives testnet `VENUE_ID=0x679795a0…e8a28c` and warns "these move". Live
right now there are **two** venues serving BTC/ETH:
- `0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c` (documented)
- `0x1a1e6821cde7d0159c0d293177871e09677b4e42307c7db3ba94f8648a5a050f` (undocumented)

What distinguishes them? Should we pin one, or filter by asset+interval and take whatever venue the
live row reports? Any planned venue change before 8 Sep?

**Assumption used meanwhile:** discover at runtime from live market rows; never pin.

---

### Q4 — Is `intervalSec` reliable as a series identifier?
Distinct `intervalSec` values on testnet include the clean series (60, 300, 900, 3600, 14400, 86400)
but also many odd values (6, 34, 45, 187, 293, 1437, 5033, 42758…). Gotcha #12 says to read
`intervalSec` rather than parsing the question text — but it doesn't look like a stable series key.

Is `intervalSec` the *scheduled* series interval or the *realised* `expiry − tradingStart` of that
particular window? What is the correct field to group "all 5-minute BTC windows" by?

**Blocks:** how we bucket windows into a feed. Assumption used meanwhile: filter to exact
`intervalSec == 300`, accept that near-miss windows are skipped.

---

### Q5 — What triggers a void, and how often should we expect one?
Recent 60s BTC/ETH windows voided with `voidPolicy: 0`. Docs say a void is "no reliable settlement",
both sides redeem 0.5. What actually causes it on testnet (oracle gap? no liquidity? no trades?),
and is the rate materially lower on the 300s series than the 60s series?

**Why it matters:** we're picking a window duration for a live demo recording; a void mid-video is
survivable but we'd rather pick the series least likely to void.

---

### Q6 — ✅ LIKELY ANSWERED IN PHASE 0
> The SDK exports `SOMNIA_TESTNET_PRICE_FEED` and the client exposes `fetchPrice()`,
> `fetchPriceCandles()` and `watchPrice()`, so a live underlying price is available on testnet
> without extra infrastructure. Remaining question is only whether it is fine to poll from a
> browser and at what rate.

### Q6 (original) — Is there a public testnet price feed for BTC/ETH spot?
`ec-oracle-follow` notes the SDK "bundles a price-feed endpoint for testnet only"
(`SOMNIA_TESTNET_PRICE_FEED`, appears to be `https://price-feed.dev.oracle.somnia.host/v1/graphql`).
Is that endpoint public and OK for a frontend to poll, so we can show the live underlying price
against the window's `strike`? Rate limits?

**Nice-to-have, not blocking:** without it we show strike + direction only, no live "distance to
strike" indicator.
