"use client";

/**
 * Mint test collateral, in one tap.
 *
 * The external faucet issues STT for gas and nothing else, so a player who
 * followed it still arrived with no tUSDC to stake — and the interface pointed
 * them back at the same faucet. That dead end sat directly in the onboarding
 * path, which is the one path the exit gate says a stranger must complete
 * unaided.
 *
 * The testnet collateral contract has a public faucet, so the wallet can mint
 * its own. It costs gas and nothing else.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount, useWalletClient } from "wagmi";

import { getWalletDexClient } from "@/lib/dexClient";
import { amount as fmt } from "@/lib/format";
import { Button } from "./ui";


/** Enough for a hundred one-tUSDC calls; not so much the faucet balks. */
const MINT_WHOLE = 100n;

export function GetFundsButton({ compact = false }: { compact?: boolean }) {
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const queryClient = useQueryClient();

  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<bigint | null>(null);
  const [error, setError] = useState<{ message: string; action?: string } | null>(null);

  const mint = async (): Promise<void> => {
    if (!address || !walletClient || busy) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const [{ mintCollateral }, dex] = await Promise.all([
        import("@predictarena/dex"),
        getWalletDexClient(walletClient, address),
      ]);
      const { minted } = await mintCollateral(dex, MINT_WHOLE);
      setDone(minted);
      // The balance strip and the stake presets both read this.
      void queryClient.invalidateQueries({ queryKey: ["balances"] });
    } catch (e) {
      // Declining the signature is a choice, not a failure.
      const msg = e instanceof Error ? e.message : "";
      if (/rejected|denied/i.test(msg)) {
        setError(null);
      } else if (e instanceof (await import("@predictarena/dex")).DexError) {
        setError({ message: e.message, ...(e.action ? { action: e.action } : {}) });
      } else {
        setError({ message: "Could not reach the faucet.", action: "Try again in a moment." });
      }
    } finally {
      setBusy(false);
    }
  };

  if (!address) return null;

  if (done !== null) {
    return (
      <p className="text-sm text-up">
        Minted {fmt(done, 0)} tUSDC. It is in your wallet — pick a stake above.
      </p>
    );
  }

  return (
    <div className={compact ? "" : "mt-1"}>
      <Button variant={compact ? "secondary" : "primary"} onClick={mint} disabled={busy}>
        {busy ? "CHECK YOUR WALLET" : `GET ${MINT_WHOLE} tUSDC`}
      </Button>
      <p className="mt-1.5 text-xs text-ink-faint">
        Mints test tokens straight to your wallet. Costs a little STT for gas, nothing else.
      </p>
      {error ? (
        <p className="mt-1 text-xs text-warn">
          {error.message} {error.action}
        </p>
      ) : null}
    </div>
  );
}
