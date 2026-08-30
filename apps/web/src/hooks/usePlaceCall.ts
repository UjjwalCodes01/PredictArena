"use client";

/**
 * Placing a call, from the browser.
 *
 * The user's wallet signs; no key ever reaches a server. `packages/dex` builds
 * the transactions and does every check it can BEFORE a signature is requested,
 * so the wallet only ever opens for something that should succeed.
 *
 * The states below are the ones AGENTS.md enumerates. Two are easy to get
 * wrong and are handled explicitly:
 *
 *  - **A rejected signature is a clean cancel**, not an error. No toast, no
 *    phantom pending row -- the user changed their mind, which is allowed.
 *  - **A reverted transaction does not throw.** The receipt has to be
 *    inspected, or a failed call sits as "Pending" forever.
 */
import { useCallback, useRef, useState } from "react";
import { useAccount, useWalletClient } from "wagmi";
import {
  prepareCall, getWindows, idempotencyKey, DexError,
  type Direction, type Window as DexWindow,
} from "@predictarena/dex";
import { getWalletDexClient } from "@/lib/dexClient";
import { addPending } from "@/lib/pending";


export type CallPhase =
  | { kind: "idle" }
  | { kind: "preparing" }
  | { kind: "approving" }
  | { kind: "signing" }
  | { kind: "confirming"; txHash: `0x${string}` }
  | { kind: "placed"; txHash: `0x${string}`; filled: bigint }
  | { kind: "cancelled" }
  | { kind: "error"; code: string; message: string; action?: string };

/** A wallet rejection, across the shapes different wallets use. */
function isUserRejection(e: unknown): boolean {
  const err = e as { code?: number | string; name?: string; message?: string; cause?: { code?: number } };
  if (err?.code === 4001 || err?.cause?.code === 4001) return true;
  if (err?.name === "UserRejectedRequestError") return true;
  return /user rejected|user denied|rejected the request/i.test(err?.message ?? "");
}

export function usePlaceCall() {
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const [phase, setPhase] = useState<CallPhase>({ kind: "idle" });
  // Guards a double-tap even faster than the disabled attribute can: the second
  // click of a rapid double-click can land before React re-renders.
  const inFlight = useRef(false);

  const reset = useCallback(() => {
    inFlight.current = false;
    setPhase({ kind: "idle" });
  }, []);

  const place = useCallback(
    async (marketId: string, direction: Direction, stake: bigint) => {
      if (inFlight.current) return;
      if (!address || !walletClient) {
        setPhase({ kind: "error", code: "NO_WALLET", message: "Connect a wallet first." });
        return;
      }

      inFlight.current = true;
      setPhase({ kind: "preparing" });

      try {
        const dex = getWalletDexClient(walletClient, address);

        // Re-read the window at click time. It may have locked while the user
        // was deciding, and placing into a locked window wastes their gas.
        const windows = await getWindows(dex, { limit: 60 });
        const target: DexWindow | undefined = windows.find((w) => w.marketId === marketId);
        if (!target) {
          setPhase({
            kind: "error",
            code: "WINDOW_CLOSED",
            message: "That window closed while you were deciding.",
            action: "The next one is already open.",
          });
          return;
        }

        // autoApprove:false so a short allowance surfaces as an explicit step
        // rather than a second, unexplained wallet prompt.
        const prepared = await prepareCall(dex, {
          window: target,
          direction,
          stake,
          account: address,
          autoApprove: false,
        }).catch(async (e: unknown) => {
          if (DexError.is(e, "NEEDS_APPROVAL")) return null;
          throw e;
        });

        let ready = prepared;
        if (!ready) {
          // Allowance is short: send the approval, then build the order again.
          setPhase({ kind: "approving" });
          const withApproval = await prepareCall(dex, {
            window: target, direction, stake, account: address, autoApprove: true,
          });
          if (withApproval.approval) {
            const approvalHash = await walletClient.sendTransaction({
              to: withApproval.approval.to as `0x${string}`,
              data: withApproval.approval.data as `0x${string}`,
              account: address,
              chain: walletClient.chain,
            });
            await dex.rpc.waitForTransactionReceipt({ hash: approvalHash });
          }
          ready = withApproval;
        }

        setPhase({ kind: "signing" });
        const txHash = await walletClient.sendTransaction({
          to: ready.order.to as `0x${string}`,
          data: ready.order.data as `0x${string}`,
          ...(ready.order.value ? { value: BigInt(ready.order.value) } : {}),
          account: address,
          chain: walletClient.chain,
        });

        setPhase({ kind: "confirming", txHash });
        const receipt = await dex.rpc.waitForTransactionReceipt({ hash: txHash });

        // A revert resolves rather than throwing. Without this check a failed
        // call would be recorded as pending and never resolve.
        if (receipt.status === "reverted") {
          setPhase({
            kind: "error",
            code: "ORDER_REJECTED",
            message: "The order was rejected on-chain.",
            action: "Usually the window locked or the price moved. Try the next window.",
          });
          return;
        }

        // Show it immediately. The indexer needs tens of seconds to report this
        // call, and an empty list in the meantime reads as failure.
        addPending({
          txHash,
          wallet: address,
          marketId,
          asset: target.asset,
          direction,
          stake: stake.toString(),
          quantity: ready.quote.quantity.toString(),
          placedAt: new Date().toISOString(),
          idempotencyKey: idempotencyKey(address, marketId as `0x${string}`).toString(),
        });

        setPhase({ kind: "placed", txHash, filled: ready.quote.quantity });
      } catch (e) {
        // Changing your mind is not an error.
        if (isUserRejection(e)) {
          setPhase({ kind: "cancelled" });
          return;
        }
        if (e instanceof DexError) {
          setPhase({ kind: "error", code: e.code, message: e.message, ...(e.action ? { action: e.action } : {}) });
          return;
        }
        setPhase({
          kind: "error",
          code: "UNKNOWN",
          message: e instanceof Error ? e.message : "The call could not be placed.",
        });
      } finally {
        inFlight.current = false;
      }
    },
    [address, walletClient],
  );

  const busy =
    phase.kind === "preparing" || phase.kind === "approving" ||
    phase.kind === "signing" || phase.kind === "confirming";

  return { phase, place, reset, busy };
}
