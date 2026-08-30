"use client";

/**
 * Unclaimed winnings, and the button that collects them.
 *
 * This closes the last hole in the loop. Settlement moves no money by itself --
 * a resolved market holds the payout until someone asks for it -- so without
 * this a winning player's balance never changes and the game looks like it does
 * not pay.
 *
 * Each position is claimed separately because each is a separate on-chain
 * redemption. Claiming them one at a time, with the row showing which is in
 * flight, is honest about that rather than pretending one tap settles everything.
 */
import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import type { Direction } from "@predictarena/dex";
import { amount } from "@/lib/format";
import { useClaim } from "@/hooks/useClaim";
import { Panel, Button, ErrorNote, Skeleton, StatusPill } from "./ui";

interface ClaimablePosition {
  marketId: string;
  outcomeIdx: 0 | 1;
  amount: string;
  estPayout: string;
  status?: string;
}

interface ClaimableResponse {
  total: string;
  positions: ClaimablePosition[];
}

export function ClaimPanel() {
  const { address, isConnected } = useAccount();
  const { phase, claim, reset, busy } = useClaim();

  const claimable = useQuery({
    queryKey: ["claimable", address],
    queryFn: async (): Promise<ClaimableResponse> => {
      const r = await fetch(`/api/claimable?wallet=${address}`, { cache: "no-store" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.message ?? "Could not check for unclaimed winnings.");
      }
      return r.json();
    },
    enabled: Boolean(address) && isConnected,
    retry: 0,
    refetchInterval: 30_000,
  });

  if (!isConnected) return null;

  if (claimable.isPending) {
    return (
      <Panel label="UNCLAIMED WINNINGS" bodyClass="p-4">
        <Skeleton className="h-10 w-full" />
      </Panel>
    );
  }

  // The indexer lookup fails transiently. Say so plainly rather than implying
  // the player has nothing -- "nothing to claim" and "we could not look" are
  // very different messages to someone who just won.
  if (claimable.isError) {
    return (
      <Panel label="UNCLAIMED WINNINGS" bodyClass="p-4">
        <ErrorNote
          title="Could not check for unclaimed winnings just now."
          action="Your winnings are safe on-chain. Try again shortly."
          onRetry={() => void claimable.refetch()}
        />
      </Panel>
    );
  }

  const total = claimable.data ? BigInt(claimable.data.total) : 0n;
  const positions = claimable.data?.positions ?? [];

  if (total === 0n || positions.length === 0) {
    return (
      <Panel label="UNCLAIMED WINNINGS" bodyClass="p-4">
        <p className="text-sm text-ink-soft">Nothing outstanding. Everything you have won is in your wallet.</p>
      </Panel>
    );
  }

  return (
    <Panel
      label="UNCLAIMED WINNINGS"
      aside={<span className="tabular text-xs font-semibold text-up">{amount(total, 2)} tUSDC</span>}
      bodyClass="p-0"
    >
      <p className="border-b border-border px-4 py-3 text-sm text-ink-soft">
        Settlement does not move funds by itself. Redeeming sends these to your wallet.
      </p>

      <ul className="divide-y divide-border">
        {positions.map((p) => {
          const direction: Direction = p.outcomeIdx === 0 ? "UP" : "DOWN";
          const claimingThis = phase.kind === "claiming" && phase.marketId === p.marketId;
          const claimedThis = phase.kind === "claimed" && phase.marketId === p.marketId;
          return (
            <li key={`${p.marketId}-${p.outcomeIdx}`} className="flex items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">
                  {direction === "UP" ? "Up" : "Down"} · {amount(p.amount, 2)} contracts
                </p>
                <p className="tabular mt-0.5 text-xs text-ink-faint">
                  pays {amount(p.estPayout, 2)} tUSDC · {p.marketId.slice(0, 10)}…
                </p>
              </div>
              {claimedThis ? (
                <StatusPill status="WON" />
              ) : (
                <Button
                  onClick={() => claim(p.marketId, direction)}
                  disabled={busy}
                  variant="secondary"
                >
                  {claimingThis ? "CONFIRM IN WALLET" : "CLAIM"}
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      <ClaimNote phase={phase} onDismiss={reset} onClaimed={() => void claimable.refetch()} />
    </Panel>
  );
}

/** What just happened, in one line, with what to do about it. */
function ClaimNote({
  phase, onDismiss, onClaimed,
}: {
  phase: ReturnType<typeof useClaim>["phase"];
  onDismiss: () => void;
  onClaimed: () => void;
}) {
  if (phase.kind === "claimed") {
    // The figure is measured from the wallet, not estimated from the book.
    return (
      <div className="border-t border-border p-4">
        <p className="rounded-sm border border-up/40 bg-up-soft px-3 py-2 text-sm text-ink">
          Claimed {amount(phase.received, 2)} tUSDC. It is in your wallet now.
        </p>
        <button onClick={() => { onDismiss(); onClaimed(); }} className="label mt-2 text-accent hover:brightness-125">
          [ REFRESH ]
        </button>
      </div>
    );
  }
  if (phase.kind === "cancelled") {
    // Deliberately quiet: declining a signature is a choice, not a failure.
    return (
      <p className="border-t border-border px-4 py-3 text-center text-sm text-ink-faint">
        Cancelled. Nothing was sent.
      </p>
    );
  }
  if (phase.kind === "error") {
    return (
      <div className="border-t border-border p-4">
        <ErrorNote
          title={phase.message}
          {...(phase.action ? { action: phase.action } : {})}
          onRetry={onDismiss}
        />
      </div>
    );
  }
  return null;
}
