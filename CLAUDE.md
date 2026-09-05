# CLAUDE.md — Prediction Leagues

Claude: read **AGENTS.md first** — it is the full project spec, architecture, and edge-case list. This file adds Claude-Code-specific working rules. AGENTS.md wins on product/architecture questions; this file wins on workflow questions.

## Project snapshot
- Prediction Leagues: social league on DreamDEX Event Contracts (Up/Down fixed-window markets) on **Somnia Shannon testnet only** (chain 50312).
- Hackathon deadline 8 Sep 2026; we submit **7 Sep**. Every task is judged against: does it protect the core flow (connect → see window → place call → settle → leaderboard) and the deadline?
- Stack: TypeScript strict, Next.js (App Router) + wagmi/viem + Tailwind, Node indexer, SQLite + Drizzle, pnpm workspace.

## Commands
```bash
pnpm install                 # workspace install
pnpm dev                     # web app (apps/web)
pnpm dev:indexer             # indexer worker
pnpm test                    # unit tests (vitest)
pnpm smoke                   # scripts/smoke.ts — live testnet round-trip (needs funded burner in .env)
pnpm lint && pnpm typecheck  # must pass before any commit
pnpm db:migrate              # drizzle migrations
```
If a command above doesn't exist yet, creating it (with this exact name) is part of the setup task.

## Hard rules (never violate)
1. **Testnet only.** Never write mainnet chain id 5031, mainnet RPC, or mainnet API into code, env samples, or docs.
2. **No secrets in git.** `.env` is gitignored from the first commit. Only a fresh testnet burner key ever appears in `.env`. If you ever see a key in a tracked file, stop and flag it.
3. **No floats for money.** All onchain amounts are `bigint`; formatting happens only in display components. If you write `parseFloat` near an amount, you are wrong.
4. **All DreamDEX I/O goes through `packages/dex`.** Never `fetch()` the DreamDEX API from UI or indexer directly.
5. **Never hard-code contract addresses** — load from `GET /v0/markets`.
6. **Do not copy from the bot kit's `examples/` folder** — stale, pre-June-2026 signatures (`placeTakerOrderWithoutVault` is removed). Use `packages/core` / `strategies/` patterns.
7. **The chain/API is the source of truth.** Never patch results in the DB by hand; fix the reconciliation logic instead.
8. Client input is untrusted: the server/indexer derives wins/losses from chain/API reads only — never from anything the browser posts.

## Workflow
- **Plan before code** for any task touching order placement, settlement, or scoring: list the states and edge cases (see AGENTS.md §5) you'll handle, then implement, then test.
- **Test-first** for money math, scoring, and week-assignment (pure functions — table-driven vitest).
- After every change: `pnpm typecheck && pnpm lint && pnpm test`. Before claiming a feature done that touches DreamDEX: run `pnpm smoke` and paste the output in your summary.
- Small, single-purpose commits with conventional messages (`feat:`, `fix:`, `chore:`). Judges read this repo — keep it clean.
- If docs at https://docs.dreamdex.io/developers/event-contracts contradict AGENTS.md assumptions (e.g. order function signature, approval flow, void semantics), update `docs/dex-notes.md` with what you found, adjust the code, and say so explicitly in your summary — don't silently reconcile.
- When genuinely blocked on a DreamDEX API ambiguity: record the exact open question in `docs/dex-notes.md` §12 and move to the next task. Don't guess-and-bury.

## Error handling pattern
- `packages/dex` throws `DexError` with machine `code` (e.g. `WINDOW_CLOSED`, `INSUFFICIENT_STAKE`, `INSUFFICIENT_GAS`, `ORDER_REJECTED`, `RATE_LIMITED`, `API_DOWN`) + human `message`.
- UI switches on `code` to show specific, actionable messages (faucet links for balance errors, network switch for chain errors). Generic "Something went wrong" is a bug.
- Position status is the enum `PENDING | WON | LOST | VOID | FAILED`. Booleans for outcomes are forbidden.

## UI standards
- Every async view has loading, empty, and error states — no exceptions. Empty leaderboard must look intentional (it's in the demo).
- Countdown timers use server-offset-corrected time, never raw client clock.
- Disable action buttons immediately on click; re-enable on definitive result.
- Mobile viewport (390px) must be usable — the demo video may show it.

## Scope guard
Before implementing anything, check AGENTS.md §2 (non-goals). If a request or your own idea falls there, don't build it; add it to `docs/cut-list.md` with one line of rationale. The demo needs one flawless flow, not breadth.

## Definition of done (per task)
- Works against live Shannon testnet (not mocks) where applicable
- Listed edge cases handled with specific error codes/UI
- Types clean, lint clean, tests pass, smoke passes if dex-touching
- No regression to the core flow
- Summary states what was verified and HOW (command output, tx hash, screenshot)
