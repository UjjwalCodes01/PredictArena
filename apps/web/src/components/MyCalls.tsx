"use client";

/**
 * A wallet's own calls.
 *
 * Read from the projection the indexer derives from chain fills, so a call
 * appears here because the chain says so -- not because this browser claims it
 * placed one.
 */
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { usePending, reconcile } from "@/lib/pending";
import { useSettlementStream } from "@/hooks/useSettlementStream";
import type { CallDto } from "@/lib/types";
import { amount, timeAgo } from "@/lib/format";
import { Card, Empty, ErrorNote, ScrollArea, Skeleton, StatusPill, LiveDot } from "./ui";

/** Older than this and the projection is behind, not merely quiet. */
const INDEXER_STALE_SEC = 180;

async function fetchCalls(wallet: string): Promise<{ calls: CallDto[]; indexerAgeSec: number | null }> {
  const r = await fetch(`/api/positions?wallet=${wallet}`, { cache: "no-store" });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.message ?? "Could not load your calls.");
  }
  return r.json();
}

export function MyCalls({ refreshKey }: { refreshKey: number }) {
  const { address, isConnected } = useAccount();
  const pending = usePending(address);
  // Push when available; the poll below remains the guarantee.
  const stream = useSettlementStream(address);

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["positions", address, refreshKey],
    queryFn: () => fetchCalls(address!),
    enabled: Boolean(address),
    // Polling is the GUARANTEE, the stream is the optimisation. When the
    // stream is live this only has to cover the moment a reconnect straddles,
    // so it backs right off instead of switching off -- a stream that silently
    // stops delivering would otherwise freeze the list forever.
    refetchInterval: stream === "live" ? 60_000 : 15_000,
  });

  // Drop optimistic rows the indexer has now reported. Matched on transaction
  // hash, so the real record always replaces the placeholder rather than
  // sitting beside it.
  useEffect(() => {
    if (data?.calls) reconcile(data.calls);
  }, [data]);

  if (!isConnected) return null;

  const total = pending.length + (data?.calls.length ?? 0);
  const hasAnything = total > 0;
  // A stopped indexer and an empty history look identical from here. Say which.
  const indexerStale =
    data?.indexerAgeSec != null && data.indexerAgeSec > INDEXER_STALE_SEC;

  return (
    <section aria-label="Your calls" className="mt-8 lg:mt-0">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="label">YOUR CALLS</h2>
          {/* The count, because a scrolling list no longer shows its own length. */}
          {total > 0 ? <span className="tabular text-xs text-ink-faint">{total}</span> : null}
        </div>
        {indexerStale ? (
          <span className="label text-warn" title="The indexer has not reported in over three minutes.">
            RESULTS DELAYED
          </span>
        ) : stream === "live" ? (
          <LiveDot label="LIVE" />
        ) : stream === "fallback" ? (
          <span className="label" title="The live channel is unavailable; updates arrive on a timer.">
            UPDATING ON A TIMER
          </span>
        ) : null}
      </div>

      {isPending ? (
        <Card className="divide-y divide-border">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center justify-between p-4">
              <div className="space-y-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-3 w-16" />
              </div>
              <Skeleton className="h-6 w-16" />
            </div>
          ))}
        </Card>
      ) : isError ? (
        <ErrorNote
          title="Could not load your calls."
          detail={error instanceof Error ? error.message : undefined}
          action="Your positions are safe on-chain; this is a display problem."
          onRetry={() => void refetch()}
        />
      ) : !hasAnything ? (
        <Card>
          <Empty
            title={indexerStale ? "Results are delayed" : "No calls yet"}
            image="/img/workspace-person.jpg"
            hint={
              indexerStale
                ? "Your calls are safe on-chain. The service that reads them is behind, so this list and the leaderboard may be out of date."
                : "Place your first call above. It will appear here the moment the chain confirms it."
            }
          />
        </Card>
      ) : (
        // Capped so the page stays about one screen. Beside the call flow on a
        // wide viewport it fills the column; on a phone it stops well short of
        // burying everything below it.
        <Card className="overflow-hidden">
          <ScrollArea label="Your calls" maxClass="max-h-[26rem] lg:max-h-[max(20rem,calc(100dvh-17rem))]">
            <div className="divide-y divide-border">
              {pending.map((p) => (
                <div key={p.txHash} className="flex items-center justify-between gap-3 p-4 opacity-80">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink">
                      {p.asset} {p.direction === "UP" ? "Up" : "Down"}
                    </p>
                    <p className="tabular mt-0.5 text-xs text-ink-faint">
                      {amount(p.stake, 2)} tUSDC · confirming
                    </p>
                  </div>
                  <StatusPill status="PENDING" />
                </div>
              ))}
              {(data?.calls ?? []).map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink">
                      {c.asset} {c.direction === "UP" ? "Up" : "Down"}
                    </p>
                    <p className="tabular mt-0.5 text-xs text-ink-faint">
                      {amount(c.stake, 2)} tUSDC · {timeAgo(c.placedAt)}
                    </p>
                  </div>
                  <StatusPill status={c.status} />
                </div>
              ))}
            </div>
          </ScrollArea>
        </Card>
      )}
    </section>
  );
}
