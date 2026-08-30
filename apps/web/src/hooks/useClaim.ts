"use client";

/**
 * Redeeming winnings, from the browser.
 *
 * Settlement moves no money by itself. A resolved market holds the payout until
 * someone asks for it, so a player who wins and never redeems watches their
 * wallet stay flat and reasonably concludes the game does not pay.
 *
 * Same trust model as placing a call: the user's wallet signs, no key ever
 * reaches a server, and the transaction is checked for a revert rather than
 * assumed to have worked.
 */
import { useCallback, useRef, useState } from "react";
import { useAccount, useWalletClient } from "wagmi";
import type { Direction } from "@predictarena/dex";
import { getWalletDexClient } from "@/lib/dexClient";


export type ClaimPhase =
  | { kind: "idle" }
  | { kind: "claiming"; marketId: string }
  | { kind: "claimed"; marketId: string; received: bigint; txHash: string }
  | { kind: "cancelled" }
  | { kind: "error"; code: string; message: string; action?: string };

/** A wallet rejection, across the shapes different wallets use. */
function isUserRejection(e: unknown): boolean {
  const err = e as { code?: number; name?: string; message?: string; cause?: { code?: number } };
  if (err?.code === 4001 || err?.cause?.code === 4001) return true;
  if (err?.name === "UserRejectedRequestError") return true;
  return /user rejected|user denied|rejected the request/i.test(err?.message ?? "");
}

export function useClaim() {
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const [phase, setPhase] = useState<ClaimPhase>({ kind: "idle" });
  // Guards a double-tap faster than the disabled attribute can: the second
  // click of a rapid double-click lands before React re-renders.
  const inFlight = useRef(false);

  const reset = useCallback(() => {
    inFlight.current = false;
    setPhase({ kind: "idle" });
  }, []);

  const claim = useCallback(
    async (marketId: string, direction: Direction) => {
      if (inFlight.current) return;
      if (!address || !walletClient) {
        setPhase({ kind: "error", code: "NO_WALLET", message: "Connect a wallet first." });
        return;
      }

      inFlight.current = true;
      setPhase({ kind: "claiming", marketId });

      try {
        const [{ redeem }, dex] = await Promise.all([
          import("@predictarena/dex"),
          getWalletDexClient(walletClient, address),
        ]);

        const result = await redeem(dex, {
          marketId: marketId as `0x${string}`,
          account: address,
          direction,
        });

        if (!result) {
          // Nothing held on that side -- already claimed, or never won it.
          setPhase({
            kind: "error",
            code: "NOTHING_TO_CLAIM",
            message: "There is nothing left to claim on that window.",
            action: "It may already have been redeemed.",
          });
          return;
        }

        setPhase({
          kind: "claimed",
          marketId,
          received: result.received,
          txHash: result.txHash,
        });
      } catch (e) {
        // Changing your mind is not an error.
        if (isUserRejection(e)) {
          setPhase({ kind: "cancelled" });
          return;
        }
        const { DexError } = await import("@predictarena/dex");
        if (e instanceof DexError) {
          setPhase({
            kind: "error",
            code: e.code,
            message: e.message,
            ...(e.action ? { action: e.action } : {}),
          });
          return;
        }
        setPhase({
          kind: "error",
          code: "UNKNOWN",
          message: e instanceof Error ? e.message : "The claim could not be completed.",
        });
      } finally {
        inFlight.current = false;
      }
    },
    [address, walletClient],
  );

  return { phase, claim, reset, busy: phase.kind === "claiming" };
}
