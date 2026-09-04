"use client";

/**
 * Challenge this player on the window you are looking at.
 *
 * A duel is the social hook: two people, one window, one question. It costs
 * nothing to issue — a signature, not a transaction — and it resolves itself
 * from the calls both sides place, so neither party has to trust the other or
 * this app.
 */
import { useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import type { WindowsResponse } from "@/lib/types";
import { shortAddress, seriesLabel } from "@/lib/format";
import { challengeMessage } from "@/lib/signedMessage";
import { Button, ErrorNote } from "./ui";

export function ChallengeButton({ opponent }: { opponent: string }) {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<{ message: string; action?: string } | null>(null);

  // Only windows still open can be challenged on; a closed one could never be
  // accepted, so it is not offered.
  const windows = useQuery({
    queryKey: ["windows", "all"],
    queryFn: async (): Promise<WindowsResponse> => {
      const r = await fetch("/api/windows", { cache: "no-store" });
      if (!r.ok) throw new Error("Could not load windows.");
      return r.json();
    },
    enabled: open,
  });

  const isSelf = address?.toLowerCase() === opponent.toLowerCase();
  if (!isConnected || isSelf) return null;

  const options = (windows.data?.windows ?? [])
    .filter((w) => w.isTradable && w.secondsLeft > 60)
    .sort((a, b) => a.closesAtSec - b.closesAtSec)
    .slice(0, 8);

  const issue = async (windowId: string): Promise<void> => {
    if (!address || busy) return;
    setBusy(true);
    setError(null);
    try {
      // The timestamp is inside the signed text, so the server can refuse a
      // replayed signature without trusting anything sent beside it.
      const issuedAt = new Date().toISOString();
      const signature = await signMessageAsync({
        message: challengeMessage(address, opponent, windowId, issuedAt),
      });
      const r = await fetch("/api/duels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challenger: address, opponent, windowId, signature, issuedAt }),
      });
      const body = await r.json();
      if (!r.ok) {
        setError({
          message: body.message ?? "Could not issue that challenge.",
          // TOO_MANY is self-explanatory; the others benefit from a next step.
          action:
            body.action ??
            (body.code === "WINDOW_CLOSED"
              ? "Pick a window with more time left."
              : body.code === "NO_WINDOW"
                ? "That window is not indexed yet. Try another."
                : undefined),
        });
        return;
      }
      setSent(true);
      setOpen(false);
    } catch (e) {
      // Declining the signature is a choice, not a failure.
      const msg = e instanceof Error ? e.message : "";
      if (!/rejected|denied/i.test(msg)) setError({ message: "Could not sign the challenge." });
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <p className="text-sm text-up">
        Challenge sent to {shortAddress(opponent)}. It resolves when the window closes.
      </p>
    );
  }

  return (
    <div>
      <Button variant="secondary" onClick={() => setOpen((v) => !v)}>
        {open ? "CANCEL" : "CHALLENGE"}
      </Button>

      {open ? (
        <div className="mt-2 rounded-md border border-border bg-surface p-3">
          <p className="label mb-2">PICK A WINDOW — YOU BOTH CALL IT</p>
          {windows.isPending ? (
            <p className="text-sm text-ink-soft">Loading open windows…</p>
          ) : options.length === 0 ? (
            <p className="text-sm text-ink-soft">
              No window has enough time left to be worth challenging on. Try again in a moment.
            </p>
          ) : (
            <ul className="space-y-1">
              {options.map((w) => (
                <li key={w.marketId}>
                  <button
                    onClick={() => void issue(w.marketId)}
                    disabled={busy}
                    className="tabular w-full rounded-sm border border-border-strong px-3 py-2 text-left text-xs text-ink hover:border-ink-faint disabled:opacity-45"
                  >
                    {w.asset} · {seriesLabel(w.intervalSec)} · closes in {Math.round(w.secondsLeft)}s
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-ink-faint">
            You will sign a message naming the window and your opponent. It costs nothing. Whoever
            calls that window correctly wins; both right or both wrong is a draw.
          </p>
          {error ? (
            <div className="mt-2">
              <ErrorNote title={error.message} {...(error.action ? { action: error.action } : {})} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
