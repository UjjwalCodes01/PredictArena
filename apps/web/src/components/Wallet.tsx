"use client";

/**
 * Wallet connection and the network guard.
 *
 * Three states this has to get right, all from AGENTS.md's wallet edge cases:
 *  - no wallet installed: the app stays browsable read-only, with a way to get one;
 *  - wrong network: actions are blocked and one button fixes it;
 *  - account switched or disconnected mid-session: state resets rather than
 *    showing the previous account's positions.
 */
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { useState } from "react";
import { TESTNET_CHAIN_ID } from "@/lib/wagmi";
import { shortAddress } from "@/lib/format";
import { Button } from "./ui";

export function useIsWrongNetwork(): boolean {
  const { isConnected, chainId } = useAccount();
  return isConnected && chainId !== TESTNET_CHAIN_ID;
}

export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connectors, connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const [open, setOpen] = useState(false);

  if (isConnected && address) {
    return (
      <div className="flex items-center gap-2">
        <span className="tabular hidden text-sm text-ink-soft sm:inline">{shortAddress(address)}</span>
        <Button variant="secondary" onClick={() => disconnect()}>
          Disconnect
        </Button>
      </div>
    );
  }

  const injected = connectors.filter((c) => c.type === "injected");

  // No injected wallet: stay browsable, and say what to do rather than
  // presenting a button that cannot work.
  if (injected.length === 0) {
    return (
      <a
        href="https://metamask.io/download/"
        target="_blank"
        rel="noreferrer noopener"
        className="rounded-lg border border-border-strong px-4 py-2.5 text-sm font-medium text-ink hover:border-ink-faint"
      >
        Install a wallet
      </a>
    );
  }

  return (
    <div className="relative">
      <Button onClick={() => (injected.length === 1 ? connect({ connector: injected[0]! }) : setOpen((v) => !v))} disabled={isPending}>
        {isPending ? "Connecting" : "Connect wallet"}
      </Button>
      {open && injected.length > 1 ? (
        <div className="absolute right-0 z-20 mt-2 w-56 rounded-lg border border-border bg-surface p-1 shadow-lg">
          {injected.map((c) => (
            <button
              key={c.uid}
              onClick={() => {
                connect({ connector: c });
                setOpen(false);
              }}
              className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-bg"
            >
              {c.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Wrong-network banner.
 *
 * `switchChain` asks the wallet to switch; if the wallet does not know Somnia
 * yet it prompts to add it, which is the `wallet_addEthereumChain` fallback the
 * plan calls for -- wagmi handles that transition for us.
 */
export function NetworkBanner() {
  const wrong = useIsWrongNetwork();
  const { switchChain, isPending, error } = useSwitchChain();

  if (!wrong) return null;

  return (
    <div role="alert" className="mb-4 rounded-lg border border-warn/40 bg-warn-soft px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-ink">Wrong network</p>
          <p className="mt-0.5 text-sm text-ink-soft">
            Prediction Leagues runs on Somnia Shannon testnet. Switch to place a call.
          </p>
        </div>
        <Button onClick={() => switchChain({ chainId: TESTNET_CHAIN_ID })} disabled={isPending}>
          {isPending ? "Check your wallet" : "Switch network"}
        </Button>
      </div>
      {error ? (
        <p className="mt-2 text-sm text-ink-soft">
          Your wallet refused the switch. You can add Somnia Shannon manually: chain ID {TESTNET_CHAIN_ID}.
        </p>
      ) : null}
    </div>
  );
}
