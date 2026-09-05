# Cut list

Things deliberately not built, and why. CLAUDE.md requires an entry here for
anything dropped — scope creep is the named failure mode of this project, and a
decision that is not written down gets relitigated.

## Out of scope from the start (AGENTS.md §2)

| Cut | Why |
|---|---|
| Real copy-trading / mirroring | Needs session keys and a delegated-execution path that DreamDEX does not document. It is the roadmap headline, not a hackathon deliverable. A cosmetic "Follow" was allowed and also cut — see below. |
| Our own smart contracts | The brief is to *consume* Event Contracts. Writing contracts would spend the whole budget on the part nobody is judging. |
| Mainnet, real funds, fiat, KYC | Testnet only, enforced at runtime and by a lint rule. |
| Accounts and passwords | The wallet address is the identity. A display name is a label on top of it, settable only with a signature from that address. |
| Mobile apps, Telegram bot | The web app must be excellent at 390px instead. |
| Admin panels, moderation, notification infra | No audience for them in a two-week demo. |

## Cut during the build

| Cut | Why |
|---|---|
| **Seed script (`scripts/seed-demo.ts`)** | Planned for Phase 5 to give the leaderboard texture. Unnecessary: the indexer scores every wallet trading the venue, so the board already carries **377 wallets and 6,265 calls** across 197 ranked players. Three seeded accounts would have been strictly less convincing than real strangers. |
| **Cosmetic "Follow" button** | Allowed by the non-goals as a roadmap teaser. Cut because a button that does nothing invites exactly one question in a demo, and the honest answer is "it does nothing". The roadmap section says it better. |
| **SSE live-updating leaderboard** | Phase 6 stretch. Polling at 20s is indistinguishable at demo pace, and the SSE path is one more thing to fail on stage. `/api/stream` exists for settlement events, which is where latency is actually visible. |
| **Telegram share deep-link** | Phase 6 stretch. The share card covers it. |
| **Sentry** | Wired an in-house `/api/client-error` + `ErrorReporter` instead. A third-party DSN in the client bundle for a testnet demo was not worth the dependency or the bundle weight. |
| **Server-side refusal `fallbacks` for the AI** | A price-direction forecast has no meaningful refusal surface, a refusal already degrades to a safe pass, and an untested beta header in a demo hot path is the larger risk. It is also unsupported on Vertex AI, so wiring it would have had to be undone. |
| **Auto-redeem on the user's behalf** | Winnings are claimed, not received. A silent sweep needs custody or a delegated path we could not confirm exists (an open question in `dex-notes.md` §12). We show an explicit "Claim" button: one extra tap, and honest about what happened. |
| **Parsing the market question text** | Its format changed three times in a week. Treated as opaque display text; all semantics come from structured fields. |

## Deferred, not cut

| Item | State |
|---|---|
| **A permanent indexer host** | The real gap. Railway's trial expired and GitHub's scheduler drops runs, so ingestion is traffic-driven via `/api/tick`. Works, and the README says exactly what it costs. |
| **Lighthouse ≥90 on the two key pages** | Bundle guard and the colour-contrast validator are in CI; a full Lighthouse run has not been executed against production. |
| **Live Vertex AI verification** | The forecaster's Vertex path is built and unit-tested, including the request URL shape, but no live call has been made — no GCP credentials on the build machine. `pnpm ai:probe` closes this in one command. |
