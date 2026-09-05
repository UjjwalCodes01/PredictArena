# Demo video — shot script

**Target: 2:30.** Hard ceiling 3:00. Record twice, keep the better take.

Presentation is 15% of the score and the video is most of it. The other 85% is
already built — this is about not undermining it.

---

## Before you press record

```bash
pnpm db:check      # projection readable, leaderboard computing
pnpm doctor        # chain + collateral identity
```

- [ ] Wallet connected, holding **STT for gas** and **tUSDC for stakes**.
      If not: the in-app **Get funds** button, or `pnpm faucet`.
- [ ] Open a **5-minute BTC window** (`TARGET_INTERVAL_SEC=300`). Long enough to
      narrate, short enough that the settlement is recordable in one sitting.
- [ ] Browser at **1440×900**, zoom 100%, bookmarks bar hidden.
- [ ] **Second window pre-loaded on `/leaderboard`** so the cut is instant.
- [ ] Notifications off. Close every unrelated tab — a Slack toast in the
      corner of a hackathon demo is the only thing anyone remembers.
- [ ] Have a wallet that already has **≥5 settled calls**, so Brier and Edge
      show real numbers instead of dashes. This matters: the dash is correct
      behaviour but it is not what you want on screen while narrating skill.
- [ ] **Run the real indexer for the whole session:** `pnpm dev:indexer` in a
      terminal you leave alone. The deployed site keeps itself fresh off page
      views, which is fine day to day — but while recording you want
      settlements landing in seconds, not on the next poke. Kill it after.
- [ ] **Rehearse the core flow once with the AI switched off** (unset
      `AI_PRIVATE_KEY` locally). Connect → call → settle → leaderboard must
      stand on its own; the forecaster is a bonus on top, not a leg it rests
      on. If anything wobbles without the AI, that is the thing to fix first.

**Record the settlement separately.** A window takes five minutes to resolve and
the video is two and a half. Place a call, let it settle off-camera, and cut to
the resolved state at 1:30. Do not wait on camera.

---

## 0:00 — 0:20 · The problem

**Screen:** `/leaderboard`, slowly scrolling.

> "Every prediction market shows you a profit and loss. A P&L cannot tell you
> whether you are good at forecasting or whether you got lucky — and over a
> weekend of five-minute windows, luck is most of what you are looking at."

Do not say the product name yet. Land the problem first.

## 0:20 — 0:40 · The answer

**Screen:** hover the **Edge** column so the tooltip shows.

> "Prediction Leagues is a weekly league on DreamDEX Event Contracts. It scores
> you the way forecasting is actually scored — Brier score, and edge over the
> price you paid. Buy Up at sixty cents, win seventy percent of the time, and
> your edge is plus ten. That is skill, and it is measurable."

Point at a real row. Say the number on screen out loud — it proves it is live.

## 0:40 — 1:30 · The live call *(the part that matters)*

**Screen:** `/` — the Play page.

> "This is a live BTC window on Somnia Shannon testnet."

1. **Point at the countdown.** "Fifty seconds until it locks."
2. **Click Up.** Let the button disable visibly.
3. **Show the wallet popup.** Do not skip this — signing is the proof it is real.
   > "That is a real order going to a real contract."
4. **Show the pending state**, then the tx hash.
   > "That is on Shannon. You can open it in the explorer right now."

If the book is thin and the order does not fill, **keep the take** and say:
> "No resting liquidity on that side — it cancels rather than filling at a bad
> price, and it tells you exactly why."

That is a better demo than a happy path. It shows real market mechanics and
error handling that names the actual problem.

## 1:30 — 1:55 · Settlement and the board

**Screen:** cut to the pre-recorded settled state.

1. The call flips **WON**.
2. Cut to `/leaderboard` — the row has moved.
   > "Points for the win, streak multiplier, and the Brier and edge update.
   > Points are recomputed from raw settlements on every read — nothing is
   > stored, so a late correction is a recompute, not a repair."
3. **The whole-venue beat — do not cut this line.** Scroll the board once,
   slowly, past rows of wallets that obviously aren't yours:
   > "And notice: one thousand three hundred players. We didn't invite them —
   > the board scores every wallet trading these markets, from public chain
   > fills. Place a trade through any app built on this venue and you're
   > already ranked here. Your streak isn't a number in your browser; it's a
   > record derived from the chain, and it can survive us."
4. Click through to a profile.

## 1:55 — 2:15 · The AI player

**Screen:** `/ai`.

> "Every AI in this space advises you, and you can never tell whether the advice
> was any good. Ours doesn't advise — it plays. Its own wallet, real orders,
> ranked on the same board by the same Brier and edge."

Scroll to the forecast log and stop on a **PASS**.

> "And most of the time it passes. It only trades when it disagrees with the
> market by enough. If it has no edge, the board says so — which is the whole
> point."

*(If the forecaster is not configured, cut this section entirely rather than
showing an offline page. 2:15 is a fine runtime.)*

## 2:15 — 2:30 · Close

**Screen:** `/leaderboard`, then hold on the URL.

> "It scores every wallet trading these markets, not just people who signed up —
> three hundred and seventy-seven of them so far. Next is copy-trading through
> session keys: follow someone with a proven Brier score, not a proven P&L."

Hold the URL still for three full seconds. **predictarena-gamma.vercel.app**

---

## Rules

- **Never say "as you can see".** Say what it is.
- **No dead air on a page load.** Cut it.
- **Say one real number per section** — a rank, a tx hash, a Brier score. Live
  numbers are what separate this from a mockup, and judges are watching for it.
- **Do not apologise** for testnet, for thin liquidity, or for anything else.
  State it and move on.
- **Do not narrate the UI** ("here I'm clicking the button"). Narrate the
  decision.

## Also capture, for the BUIDL page

- `/leaderboard` full page, Brier and Edge visible
- `/` mid-call, with the wallet signature prompt open
- `/ai` showing a forecast rationale
- `/terminal` — it photographs well and reads as instrumentation
- One shot at **390px mobile**, proving it works on a phone
