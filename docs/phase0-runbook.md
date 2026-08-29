# Phase 0 runbook — Recon & Ground Truth

PLAN.md Phase 0. **Exit gate:** `docs/dex-notes.md` complete · one settled Event Contract tx hash
recorded · four funded wallets.

Everything below is built and verified against live Shannon except the one step that needs a human
at a web faucet.

---

## Status

| # | Gate item | State |
|---|---|---|
| 1 | `docs/dex-notes.md` complete | ✅ verified against the live chain, indexer and SDK |
| 2 | One settled Event Contract tx hash | ✅ two placed; one WON and redeemed for +1.7510 tUSDC |
| 3 | Four funded wallets | ✅ DEV funded (50 STT / ~10k tUSDC). SEED1-3 generated, funded at Phase 5 |

`pnpm gate` reports **Phase 0 complete**. Measurements and tx hashes are in
[dex-notes.md §13](dex-notes.md).

Also done, ahead of the plan: `docs/questions-for-telegram.md` (Q3 and Q6 answered during recon).
Still open from PLAN.md's task list: joining the hackathon Telegram and skimming the DoraHacks Q&A
tab — both need your account.

---

## Run it

```bash
pnpm install          # once
pnpm wallets          # 4 burner wallets -> .env (mode 600). Already run; safe to re-run.
```

**→ Then the one manual step.** Open **https://testnet.somnia.network** and request **STT** for the
DEV address (`pnpm wallets` prints it; it is also in `.env`).

Get at least **0.6 STT**. That is not arbitrary: the SDK sends every write with a fixed 10,000,000
gas ceiling at 60 gwei, and the mempool only admits a transaction whose ceiling is funded. A wallet
holding 0.1 STT looks funded and still gets refused.

```bash
pnpm faucet           # mints tUSDC on-chain — no web faucet needed for collateral
pnpm doctor           # 20 read-only checks; signs nothing
pnpm place-one        # THE EXIT GATE: one real order -> settlement -> redeem
pnpm gate             # verifies all three gate conditions against reality
```

To rehearse without signing anything: `pnpm place-one --dry-run`.

---

## What each script does

| Command | Purpose |
|---|---|
| `pnpm wallets` | Generates DEV + SEED1..3. Refuses to run unless `.gitignore` excludes `.env`; refuses to overwrite existing (possibly funded) keys without `--force`; never prints a key to stdout. |
| `pnpm faucet` | Mints tUSDC via the collateral contract's own `faucet(uint256)`. `--slot DEV`, `--amount 10000`. |
| `pnpm doctor` | Safety rail, chain identity, collateral identity, contract bytecode, indexer reachability + lag, venue discovery, live series map, window selection, book params, liquidity, wallet balances, unclaimed winnings. Reports everything wrong in one pass. |
| `pnpm place-one` | Places ONE real order and follows it to settlement and redemption. `--dry-run`, `--claim-only`, `--side up\|down`, `--asset BTC\|ETH`, `--interval 300`, `--yes`. Writes `artifacts/phase0-probe.json`. |
| `pnpm gate` | Checks the three exit-gate conditions. Exit code 0 only when Phase 0 is genuinely done. |

---

## Things that will bite, and how these scripts handle them

- **A reverted SDK write does not throw.** The receipt rides on the result. Every write here checks
  `receipt.status === "reverted"` explicitly — otherwise a failed order becomes a phantom pending row.
- **Winnings are claimed, not received.** Settlement moves no funds. `place-one` redeems after
  settling; `place-one --claim-only` sweeps anything left behind.
- **The indexer lags the chain by seconds.** Window selection gates on the *on-chain* status
  (`1 = Trading`), never the indexer row.
- **Expiry headroom scales with the series.** A flat 300s threshold would reject every 60s and 300s
  window; a fixed small one would let a window lock mid-send. `headroomSecFor()` uses 15% of the
  interval, clamped to 5–60s.
- **Order expiry is mandatory** and capped at the market's own expiry, so a crashed run leaves
  nothing resting on the book.
- **Idempotency** rides on `PlaceOrderParams.userData` — the client-order-id field AGENTS.md §5 asks
  for — derived deterministically from `(wallet, marketId)`.
- **VOID is a real and common outcome**, not a rare edge. It is handled as a first-class result, not
  an error.
- **Mainnet cannot be reached by accident.** Chain id, endpoint hostnames and the collateral token
  are all asserted at runtime. An address allowlist would be useless here — 8 of the 11 protocol
  contracts are byte-identical across the two networks.

---

## Layout

```
scripts/
  lib/config.ts    env + the testnet-only guard + faucet/explorer links
  lib/dex.ts       the ONLY module that talks to DreamDEX (CLAUDE.md rule 4)
  lib/money.ts     bigint money math; no float ever touches an amount
  lib/log.ts       check/report/summarise with machine codes + human actions
  gen-wallets.ts   faucet.ts   doctor.ts   place-one.ts   phase0-gate.ts
```

`scripts/lib/` is written to be **promoted into `packages/dex` in Phase 1**, not thrown away.
`DexError` already carries the machine `code` the UI will switch on.

---

## Note on scope

This is Phase 0 tooling only — a single root `package.json`, no workspace. PLAN.md Phase 1 owns the
pnpm workspace scaffold, CI and the real `packages/dex`; the root layout here is already shaped to
become that workspace root without a rewrite.
