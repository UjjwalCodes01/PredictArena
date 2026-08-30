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
