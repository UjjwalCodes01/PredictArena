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
import type { Direction, Window as DexWindow } from "@predictarena/dex";
import { getWalletDexClient } from "@/lib/dexClient";
import { addPending } from "@/lib/pending";


/**
 * How long to wait before telling the user a transaction is slow.
 *
 * Shannon blocks in about a second, so twenty is already deeply abnormal —
 * long enough not to cry wolf on a brief hiccup, short enough that nobody
 * stares at a spinner wondering whether the app has died.
 */
const CONFIRM_PATIENCE_MS = 20_000;
/** After which we stop holding the request open. Background polling continues. */
const CONFIRM_GIVE_UP_MS = 180_000;

export type CallPhase =
  | { kind: "idle" }
  | { kind: "preparing" }
  | { kind: "approving" }
  | { kind: "signing" }
  | { kind: "confirming"; txHash: `0x${string}` }
  /**
   * Sent, accepted by the network, but not mined inside our patience.
   *
   * NOT a failure — the transaction is live and may still confirm. The
   * distinction matters: telling someone their call failed when it is about to
   * succeed invites them to place a second one.
   */
  | { kind: "slow"; txHash: `0x${string}` }
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
        // The SDK arrives with the client, on the first call — not in the bundle
        // every page downloads.
        const [sdk, dex] = await Promise.all([
          import("@predictarena/dex"),
          getWalletDexClient(walletClient, address),
        ]);
        const { prepareCall, getWindows, idempotencyKey, DexError } = sdk;

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
            const approvalReceipt = await dex.rpc
              .waitForTransactionReceipt({ hash: approvalHash, timeout: CONFIRM_GIVE_UP_MS })
              .catch(() => null);
            if (!approvalReceipt || approvalReceipt.status === "reverted") {
              setPhase({
                kind: "error",
                code: "ORDER_REJECTED",
                message: "The approval did not go through.",
                action: "Try again — nothing was staked.",
              });
              return;
            }
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

        // viem waits forever by default. A stalled chain would leave this on
        // "Placing your call" with no explanation and no way out, which is the
        // stuck-transaction case the plan calls for.
        let receipt = await dex.rpc
          .waitForTransactionReceipt({ hash: txHash, timeout: CONFIRM_PATIENCE_MS })
          .catch(() => null);

        if (!receipt) {
          // Say so, offer the explorer, and KEEP WAITING in the background.
          setPhase({ kind: "slow", txHash });
          receipt = await dex.rpc
            .waitForTransactionReceipt({ hash: txHash, timeout: CONFIRM_GIVE_UP_MS })
            .catch(() => null);
        }

        if (!receipt) {
          // Still nothing. The transaction remains live on-chain and the
          // indexer will pick it up if it lands, so this is reported as
          // unconfirmed rather than failed.
          setPhase({
            kind: "error",
            code: "SETTLEMENT_TIMEOUT",
            message: "Your call was sent but has not confirmed yet.",
            action: "It may still land. Check the explorer, and do not send it twice.",
          });
          return;
        }

        // A revert resolves rather than throwing. Without this check a failed
        // call would be recorded as pending and never resolve.
        if (receipt.status === "reverted") {
          // The receipt carries no reason, but the chain still can: re-run
          // the same call at the block it mined in and the revert comes back
          // with its selector. Best-effort — a guess-free specific message
          // beats the confident wrong diagnosis that misled a player whose
          // actual problem was balance, but never let diagnosis itself fail
          // the error path.
          const replayed = await dex.rpc
            .call({
              to: ready.order.to as `0x${string}`,
              data: ready.order.data as `0x${string}`,
              account: address,
              blockNumber: receipt.blockNumber,
            })
            .then(() => null)
            .catch((e: unknown) => e);

          const { isUnfillable, isInsufficientBalance } = await import("@predictarena/dex");
          if (replayed && isUnfillable(replayed)) {
            setPhase({
              kind: "error",
              code: "NO_LIQUIDITY",
              message: "Nothing filled — the book moved before your order landed.",
              action: "Nothing was staked or lost besides gas. The price is fresh again; retry.",
            });
            return;
          }
          if (replayed && isInsufficientBalance(replayed)) {
            setPhase({
              kind: "error",
              code: "INSUFFICIENT_STAKE",
              message:
                "The pool holds the full max payout until settlement, and the balance could not cover it at this price.",
              action: "Try a smaller stake, or a likelier side.",
            });
            return;
          }
          setPhase({
            kind: "error",
            code: "ORDER_REJECTED",
            message: "The order was rejected on-chain.",
            action:
              "The window may have locked, the price moved, or the balance could not cover " +
              "the max payout the pool escrows. Try a smaller stake or the next window.",
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
        // The SDK may not have loaded if the failure happened before its
        // import resolved, so it is fetched here rather than assumed present.
        const { DexError, isInsufficientBalance } = await import("@predictarena/dex");
        // The wallet simulates before sending, so this arrives as a thrown
        // revert with data — decodable, unlike a mined revert's receipt.
        // Preflight normally refuses it first; this covers a balance that
        // changed between the check and the send.
        if (isInsufficientBalance(e)) {
          setPhase({
            kind: "error",
            code: "INSUFFICIENT_STAKE",
            message:
              "The pool holds the full max payout until settlement, and your balance cannot cover it at this price.",
            action: "Try a smaller stake, or a likelier side.",
          });
          return;
        }
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
    phase.kind === "signing" || phase.kind === "confirming" || phase.kind === "slow";

  return { phase, place, reset, busy };
}
