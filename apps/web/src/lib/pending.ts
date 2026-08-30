"use client";

/**
 * Calls this browser has sent but the indexer has not yet reported.
 *
 * The chain confirms in seconds; the projection catches up in tens of seconds.
 * Without this, a user who just signed sees an empty list and reasonably
 * concludes their call failed -- so they tap again.
 *
 * These rows are a DISPLAY convenience only. Nothing here is ever trusted as
 * truth: the moment the indexer reports a call with the same transaction hash,
 * the optimistic row is dropped in favour of the real one (AGENTS.md -- the
 * chain is the source of truth, never the browser).
 *
 * Session-scoped and in-memory on purpose. A refresh clears it, which is
 * correct: after a reload the server's answer is the only one worth showing.
 */
import { useSyncExternalStore } from "react";
import type { CallDto } from "./types";

export interface PendingCall {
  txHash: string;
  wallet: string;
  marketId: string;
  asset: string;
  direction: "UP" | "DOWN";
  stake: string;
  quantity: string;
  placedAt: string;
  /** Deterministic per (wallet, window) -- the same key the order carries on-chain. */
  idempotencyKey: string;
}

let rows: PendingCall[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function addPending(call: PendingCall): void {
  // The idempotency key is deterministic per wallet and window, so a double-tap
  // cannot produce two optimistic rows any more than it can produce two orders.
  if (rows.some((r) => r.idempotencyKey === call.idempotencyKey)) return;
  rows = [call, ...rows];
  emit();
}

/** Drop anything the server has now reported, matched on transaction hash. */
export function reconcile(serverCalls: readonly CallDto[]): void {
  if (rows.length === 0) return;
  const known = new Set(serverCalls.map((c) => c.txHash.toLowerCase()));
  const kept = rows.filter((r) => !known.has(r.txHash.toLowerCase()));
  if (kept.length !== rows.length) {
    rows = kept;
    emit();
  }
}

export function clearPending(): void {
  if (rows.length === 0) return;
  rows = [];
  emit();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const EMPTY: PendingCall[] = [];

/**
 * The store's contents for one wallet.
 *
 * A plain function, not a hook, so the behaviour can be tested without
 * rendering anything. `usePending` is the thin React wrapper over it.
 */
export function getPendingFor(wallet?: string): PendingCall[] {
  if (!wallet) return EMPTY;
  const w = wallet.toLowerCase();
  return rows.filter((r) => r.wallet.toLowerCase() === w);
}

export function usePending(wallet?: string): PendingCall[] {
  const all = useSyncExternalStore(
    subscribe,
    () => rows,
    // The server render has no browser state; a stable empty array keeps
    // hydration from mismatching.
    () => EMPTY,
  );
  if (!wallet) return EMPTY;
  const w = wallet.toLowerCase();
  return all.filter((r) => r.wallet.toLowerCase() === w);
}
