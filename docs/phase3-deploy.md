# Phase 3 — deploying, and the manual test matrix

The Phase 3 exit gate is not something a script can assert:

> A tester on a fresh wallet completes connect → fund → call → settle → see themselves on the
> leaderboard **without any help**, on the **deployed** preview — and the manual matrix passes.

Everything a machine can check is green. What follows is what a person has to do.

---

## Deploying the web app

The app is a normal Next.js project inside a pnpm workspace, so the only thing Vercel needs told is
to install from the workspace root. `apps/web/vercel.json` does that.

1. **Import the repo** at vercel.com, and set **Root Directory to `apps/web`**.
2. **Environment variables** — Production and Preview both:

   | Variable | Value | Why |
   |---|---|---|
   | `DATABASE_URL` | your Neon **pooled** connection string | serverless functions open many short connections; the pooled endpoint is the one built for that |
   | `INDEXER_URL` | `https://dev.smk.somnia.host/v1/graphql` | Shannon market data |
   | `RPC_HTTP_URL` | `https://dream-rpc.somnia.network` | chain reads |
   | `RPC_WS_URL` | `wss://dream-rpc.somnia.network/ws` | live tail |
   | `WALLETCONNECT_PROJECT_ID` | *(optional)* from cloud.walletconnect.com | offers WalletConnect alongside injected wallets. Public — it identifies the app, it authorises nothing. Omit it and the site still works, offering MetaMask/Brave only. |

   `DATABASE_URL` is a secret and is only ever read server-side (`src/lib/server.ts`). Nothing in the
   browser bundle references it.

3. **Deploy.** Then open `/start` on a phone and walk the four steps.

## Keeping the projection fresh

**Symptom if you skip this:** calls settle on-chain, the leaderboard never moves, and a player who
just placed a call sees "no calls yet". Nothing errors — it is silently, completely stale. The app
now says so ("RESULTS DELAYED") rather than pretending the wallet has no history, but the fix is to
keep ingestion running.

Two ways, in order of preference:

**1. Run the daemon** (best). It tails live chain events and reacts in seconds. Needs a host that
keeps a process alive — Railway, Fly, or any small VPS.

> **A gap is not fully recoverable.** The catch-up sweep can re-scan a window it saw while that
> window was live, because the pool address was stored then. It cannot recover a window whose
> entire life passed with nothing watching: the venue lists live markets only (`includeInactive`
> returns the same rows), so there is nothing left to enumerate. Those calls stay invisible to the
> leaderboard permanently, even though they are perfectly safe on-chain. A brief outage is
> survivable; an outage of hours costs you every call placed during it.

**2. Drive it from a scheduler** (works on Vercel alone). `GET /api/cron/ingest` runs one full
cycle: ingest windows, ingest calls, catch up closed windows, reconcile settlements. Set
`CRON_SECRET` in the environment and it is reachable as:

```
curl "https://<your-app>/api/cron/ingest?key=$CRON_SECRET"
```

`vercel.json` already schedules it every 5 minutes. Vercel Cron sends the secret as a bearer token
automatically. On a plan where fine-grained crons are unavailable, point any external scheduler
(GitHub Actions `schedule`, cron-job.org) at the same URL.

Without `CRON_SECRET` the endpoint returns 503 and does nothing — it is not a public trigger for
unbounded chain work.

## The indexer is a separate process

Vercel runs functions, not daemons — the indexer must live somewhere that stays running (Railway,
Fly, or any small VPS). It needs the same four variables.

**The indexer must stay up, but a gap is no longer fatal.** It runs a catch-up sweep every two
minutes over windows that closed recently, reading their fills directly by pool address from our
own table. Before that existed, any window that settled while the indexer was down dropped off the
venue's live list within minutes and every call placed on it was lost permanently -- players simply
vanished from the leaderboard. The first run of that sweep recovered 57 calls, and the board went
from 97 players to 146.

**Run it as a direct process, not through a package-manager wrapper.** `kill -9` on an
`npx`/`pnpm` wrapper orphans the worker: during Phase 2 one kept running for four minutes and
corrupted a measurement. Point the supervisor at the real PID:

```
tsx apps/indexer/src/main.ts
```

Without the indexer the site still loads and calls still place — the chain is unaffected — but the
leaderboard and history stop updating, because those read the projection it maintains.

---

## Manual test matrix

Run against the **deployed** URL, on a phone, with a wallet that has never used the app.

| # | Case | What must happen |
|---|---|---|
| 1 | **No wallet installed** | Site is fully browsable. Header offers "Install a wallet", nothing is broken. |
| 2 | **Connect** | One tap. Address appears truncated in the header. |
| 3 | **Wrong network** | Amber banner appears; "Switch network" fixes it in one tap. Actions stay blocked until it does. |
| 4 | **Zero STT** | Placing a call fails *before* the wallet opens, saying gas is missing, with a faucet link. Not a revert. |
| 5 | **Zero tUSDC** | Same shape: refused before signing, names the missing token, links the faucet. |
| 6 | **Reject the signature** | Reads "Cancelled. Nothing was sent." No error styling. No phantom pending row. |
| 7 | **Double-tap the call button** | Exactly one transaction. The button disables on the first tap. |
| 8 | **Switch account mid-flow** | "Your calls" and the highlighted leaderboard row follow the new account; no data from the old one lingers. |
| 9 | **Window closes while deciding** | The call is refused with "that window closed", and the next window is already showing. |
| 10 | **Place a real call** | Wallet opens once (twice if an approval is needed, and the approval step is labelled). Status shows Pending. |
| 11 | **Wait for settlement** | Within ~60s of close the status flips to Won, Lost or Void. |
| 12 | **Leaderboard** | Your address appears, with your row highlighted and pinned at the top. |
| 13 | **Set a profile** | `/settings` → name, bio, links → sign → saved. Public page shows it. |
| 14 | **Share card** | Paste your `/p/<address>` link into any chat; the preview shows rank and record. |
| 15 | **Airplane mode mid-view** | Panels show an error with a retry, not a white screen. |

### Cold starts

The database is serverless and suspends when idle; waking it takes ten to twenty seconds. Measured
on a fresh server, `/api/standings` returned **503 after 41 seconds** of retries — the exact state a
judge opening a link arrives in.

Two changes fix it:

- `apps/web/instrumentation.ts` runs once per server instance **before it serves traffic** and
  performs the real leaderboard query (not a `SELECT 1` — that query is the heaviest read the app
  makes and the one that timed out). It retries, and logs each leg:
  `[warm-up] database: ready, chain clock: ready`.
- `dbRead()` wraps every database read in the request path with a bounded retry, sized against an
  actual wake-up rather than a guess, for a database that suspends again while the server runs.

First-visitor latency on standings went from **20.9s (or a 503) to 1.4s**.

On Vercel each cold serverless instance runs the same warm-up, so the cost is paid per instance
rather than per visitor.

### Live settlement updates

Task 4 asks for push over polling. `/api/stream` is a Server-Sent Events endpoint that watches one
wallet's call statuses and emits `changed` when any of them move; the browser then re-reads through
the normal endpoint, so there is exactly one code path shaping call data.

**Polling is still the guarantee.** The stream is an optimisation and is treated as one: the client
keeps a slow poll running (60s while the stream is live, 15s when it is not), because corporate
proxies strip `text/event-stream`, serverless platforms cap connection lifetime, and phones suspend
background tabs. A stream that silently stops delivering must not freeze the list.

Two deployment notes:

- The server closes each stream at **4 minutes** and the client reconnects with backoff. That is
  deliberately under typical serverless wall-time caps, so the browser reconnects on our terms
  rather than seeing a truncated response.
- The response sets `x-accel-buffering: no`. Nginx buffers proxied responses by default, which
  would hold every event until the stream ended — exactly defeating the point.

### Covered since the first pass

- **WalletConnect** is offered when `WALLETCONNECT_PROJECT_ID` is set, so the matrix can be run
  from a phone wallet rather than only a desktop extension.
- **Balances are read before a stake is chosen**, so "not enough STT" and "not enough tUSDC" are
  two different messages with two different fixes — cases 4 and 5 no longer depend on a thrown
  error to surface.
- **An optimistic PENDING row** appears the moment a transaction confirms, keyed by the same
  idempotency key the order carries on-chain, and disappears when the indexer reports the real
  record. Case 7 no longer shows an empty list between signing and indexing.
- **Session state clears on account switch**, so case 8 cannot show one account's calls under
  another's name.
- **A window that locks mid-decision rolls to the next one with a notice**, rather than leaving a
  dead panel with an error in it (case 9).
- **An order that cannot fill says so specifically.** An IOC with no depth on the other side
  reverts with `ImmediateOrCancel`; that is now `NO_LIQUIDITY` with "try a smaller stake, or the
  other direction", not the generic "the window locked, the price moved, or escrow was short".
  Live testing hit this five times consecutively on a 80-83% favourite — nobody sells a
  near-certainty, so the ask side on a favourite is often empty.

### The core loop, proven end to end on live testnet

`pnpm smoke` completed a full round-trip on Shannon in 66 seconds:

| Step | Result |
|---|---|
| Quote | UP at 94.6% implied, 1.0570 contracts for 0.9999 tUSDC |
| Place | filled 1.0570/1.0570, spent 0.9914 tUSDC |
| Settle | RESOLVED, winner UP -> **WON** |
| Redeem | received 1.0570 tUSDC |

And separately, a call placed by the dev wallet settled and **appeared on the leaderboard** at
rank #143 (0W-1L) -- closing the connect -> call -> settle -> leaderboard chain with real data.

### Already verified by machine

- Signature is load-bearing: a tampered payload and a wrong wallet both return **401**.
- URL scheme allowlist: `javascript:`, `data:`, `vbscript:`, `file:` and `ftp:` are all refused.
- All 10 pages return 200; all 22 images serve; **zero emoji** in any rendered page.
- `typecheck`, `lint`, **187 tests**, `build`, and `check:bundle` all pass.
- Warm API latency is 3–18ms across every endpoint (see the caching notes in `lib/cache.ts`).
- Colour: the Up/Down pair passes the palette validator including colourblind separation
  (deutan ΔE 13.4 against a threshold of 8).

### Known limits, stated rather than hidden

- **Claiming is per position, not one tap for all.** Each redemption is its own on-chain
  transaction, and the panel is honest about that rather than pretending otherwise.
- **Only BTC and ETH** are surfaced, though the venue has listed a third asset. Liquidity on the
  others is thin and the demo should not depend on it.
- Leaderboard rows and stats are client-fetched, so the first paint is skeletons. Fine for an app,
  worth moving server-side if this ever needs to be indexed by search engines.
