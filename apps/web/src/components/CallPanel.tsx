"use client";

/**
 * The call flow.
 *
 * One decision at a time, in the order a person actually makes them:
 *   which way  ->  how much  ->  confirm.
 *
 * Nothing is hidden behind a modal and no step appears before the one before it
 * is answered, so the screen never shows more than the next choice.
 */
import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import type { Direction } from "@predictarena/dex";
import type { WindowDto, QuoteDto } from "@/lib/types";
import { amount, percent, countdown, seriesLabel } from "@/lib/format";
import { usePlaceCall } from "@/hooks/usePlaceCall";
import { useIsWrongNetwork } from "./Wallet";
import { Button, Card, ErrorNote, Skeleton } from "./ui";

const STAKE_PRESETS = [1, 5, 10] as const;
const COLLATERAL_UNIT = 1_000_000n; // 6 decimals

export function CallPanel({
  window: w,
  secondsLeft,
  onPlaced,
}: {
  window: WindowDto;
  secondsLeft: number;
  onPlaced: () => void;
}) {
  const { isConnected } = useAccount();
  const wrongNetwork = useIsWrongNetwork();
  const { phase, place, reset, busy } = usePlaceCall();

  const [direction, setDirection] = useState<Direction | null>(null);
  const [stakeWhole, setStakeWhole] = useState<number>(1);
  const [quote, setQuote] = useState<QuoteDto | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);

  const stake = BigInt(stakeWhole) * COLLATERAL_UNIT;
  const closed = secondsLeft <= 0 || !w.isTradable;

  // Re-price whenever the choice changes. The quote is an estimate: takers pay
  // the fill price, so the exact cost only exists after the fill.
  useEffect(() => {
    if (!direction) { setQuote(null); return; }
    let cancelled = false;
    setQuoting(true);
    setQuoteError(null);
    const url = `/api/quote?marketId=${w.marketId}&direction=${direction}&stake=${stake}`;
    fetch(url)
      .then(async (r) => {
        const body = await r.json();
        if (cancelled) return;
        if (!r.ok) { setQuote(null); setQuoteError(body.message ?? "Could not price this call."); return; }
        setQuote(body as QuoteDto);
      })
      .catch(() => { if (!cancelled) setQuoteError("Could not reach the pricing service."); })
      .finally(() => { if (!cancelled) setQuoting(false); });
    return () => { cancelled = true; };
  }, [direction, stake, w.marketId]);

  // A completed call clears the form so the panel is ready for the next window.
  useEffect(() => {
    if (phase.kind === "placed") {
      onPlaced();
      const t = setTimeout(() => { reset(); setDirection(null); }, 6000);
      return () => clearTimeout(t);
    }
  }, [phase.kind, onPlaced, reset]);

  if (closed) {
    return (
      <Card className="p-4">
        <p className="text-sm text-ink-soft">
          This window has stopped taking calls. The next one opens automatically.
        </p>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      {/* Step 1 - which way */}
      <div className="border-b border-border p-4">
        <span className="label">DIRECTION</span>
        <p className="mb-3 mt-1 text-sm font-medium text-ink">
          Will {w.asset} close higher after {seriesLabel(w.intervalSec)}?
        </p>
        <div className="grid grid-cols-2 gap-3">
          <DirectionButton
            label="Up"
            hint="Closes at or above the opening price"
            price={w.upPrice}
            selected={direction === "UP"}
            disabled={busy || w.upPrice === null}
            onClick={() => setDirection("UP")}
          />
          <DirectionButton
            label="Down"
            hint="Closes below the opening price"
            price={w.downPrice}
            selected={direction === "DOWN"}
            disabled={busy || w.downPrice === null}
            onClick={() => setDirection("DOWN")}
          />
        </div>
        {w.upPrice === null && w.downPrice === null ? (
          <p className="mt-3 text-sm text-ink-soft">
            No one is quoting this window yet. Prices appear as soon as someone does.
          </p>
        ) : null}
      </div>

      {/* Step 2 - how much */}
      {direction ? (
        <div className="border-b border-border p-4">
          <span className="label">STAKE</span>
          <p className="mb-3 mt-1 text-sm font-medium text-ink">How much do you want to stake?</p>
          <div className="flex gap-2" role="group" aria-label="Stake amount">
            {STAKE_PRESETS.map((v) => (
              <button
                key={v}
                onClick={() => setStakeWhole(v)}
                disabled={busy}
                aria-pressed={stakeWhole === v}
                className={`tabular flex-1 rounded-sm border px-3 py-2.5 text-sm font-medium transition-colors disabled:opacity-45 ${
                  stakeWhole === v
                    ? "border-accent bg-accent-soft text-accent"
                    : "border-border-strong text-ink hover:border-ink-faint"
                }`}
              >
                {v} tUSDC
              </button>
            ))}
          </div>

          <div className="mt-3 min-h-[2.5rem] text-sm">
            {quoting ? (
              <Skeleton className="h-5 w-56" />
            ) : quoteError ? (
              <p className="text-ink-soft">{quoteError}</p>
            ) : quote ? (
              <p className="text-ink-soft">
                You get <span className="tabular font-medium text-ink">{amount(quote.quantity, 2)}</span> contracts.
                {" "}If {direction === "UP" ? "Up" : "Down"} wins they pay{" "}
                <span className="tabular font-medium text-ink">{amount(quote.maxPayout, 2)} tUSDC</span>.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Step 3 - confirm */}
      {direction ? (
        <div className="p-4">
          <PlaceAction
            disabled={!isConnected || wrongNetwork || !quote || busy || quoting}
            isConnected={isConnected}
            wrongNetwork={wrongNetwork}
            phase={phase}
            direction={direction}
            secondsLeft={secondsLeft}
            onPlace={() => place(w.marketId, direction, stake)}
          />
          <PhaseNote phase={phase} onDismiss={reset} />
        </div>
      ) : null}
    </Card>
  );
}

function DirectionButton({
  label, hint, price, selected, disabled, onClick,
}: {
  label: "Up" | "Down";
  hint: string;
  price: string | null;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  // Class names are written out in full, never interpolated: Tailwind scans the
  // source for literal strings, so `bg-${tone}-soft` would compile to nothing.
  const isUp = label === "Up";
  const selectedRing = isUp ? "border-up bg-up-soft" : "border-down bg-down-soft";
  const labelTone = isUp ? "text-up" : "text-down";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={`rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
        selected ? selectedRing : "border-border-strong hover:border-ink-faint"
      }`}
    >
      <span className={`block font-[family-name:var(--font-mono)] text-sm font-bold uppercase tracking-wider ${labelTone}`}>
        {label}
      </span>
      <span className="mt-1 block text-xs leading-snug text-ink-faint">{hint}</span>
      <span className={`tabular mt-2 block text-xl font-bold ${price === null ? "text-ink-faint" : labelTone}`}>
        {price === null ? "—" : percent(BigInt(price))}
      </span>
      <span className="label mt-0.5 block">{price === null ? "NO QUOTE" : "IMPLIED CHANCE"}</span>
    </button>
  );
}

function PlaceAction({
  disabled, isConnected, wrongNetwork, phase, direction, secondsLeft, onPlace,
}: {
  disabled: boolean;
  isConnected: boolean;
  wrongNetwork: boolean;
  phase: ReturnType<typeof usePlaceCall>["phase"];
  direction: Direction;
  secondsLeft: number;
  onPlace: () => void;
}) {
  if (!isConnected) {
    return <p className="text-sm text-ink-soft">Connect a wallet to place this call.</p>;
  }
  if (wrongNetwork) {
    return <p className="text-sm text-ink-soft">Switch to Somnia Shannon to place this call.</p>;
  }

  const label =
    phase.kind === "preparing" ? "Checking your balance"
    : phase.kind === "approving" ? "Approve tUSDC in your wallet"
    : phase.kind === "signing" ? "Confirm in your wallet"
    : phase.kind === "confirming" ? "Placing your call"
    : phase.kind === "placed" ? "Call placed"
    : `Call ${direction === "UP" ? "Up" : "Down"}`;

  return (
    <>
      <Button className="w-full" onClick={onPlace} disabled={disabled || phase.kind === "placed"}>
        {label}
      </Button>
      <p className="mt-2 text-center text-xs text-ink-faint">
        Settles in {countdown(secondsLeft)} when the window closes.
      </p>
    </>
  );
}

/** What just happened, in one line, with what to do about it. */
function PhaseNote({
  phase, onDismiss,
}: { phase: ReturnType<typeof usePlaceCall>["phase"]; onDismiss: () => void }) {
  if (phase.kind === "placed") {
    return (
      <p className="mt-3 rounded-lg border border-up/40 bg-up-soft px-3 py-2 text-sm text-ink">
        Call placed. It will settle when the window closes.
      </p>
    );
  }
  if (phase.kind === "cancelled") {
    // Deliberately quiet: rejecting a signature is a choice, not a failure.
    return (
      <p className="mt-3 text-center text-sm text-ink-faint">
        Cancelled. Nothing was sent.
      </p>
    );
  }
  if (phase.kind === "error") {
    return (
      <div className="mt-3">
        <ErrorNote
          title={phase.message}
          {...(phase.action ? { action: phase.action } : {})}
          onRetry={onDismiss}
        />
        {phase.code === "INSUFFICIENT_GAS" || phase.code === "INSUFFICIENT_STAKE" ? (
          <a
            href="https://testnet.somnia.network"
            target="_blank"
            rel="noreferrer noopener"
            className="mt-2 inline-block text-sm font-medium text-accent underline underline-offset-2"
          >
            Get testnet funds
          </a>
        ) : null}
      </div>
    );
  }
  return null;
}
