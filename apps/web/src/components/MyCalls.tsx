"use client";

/**
 * A wallet's own calls.
 *
 * Read from the projection the indexer derives from chain fills, so a call
 * appears here because the chain says so -- not because this browser claims it
 * placed one.
 */
import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import type { CallDto } from "@/lib/types";
import { amount, timeAgo } from "@/lib/format";
import { Card, Empty, ErrorNote, Skeleton, StatusPill } from "./ui";

async function fetchCalls(wallet: string): Promise<{ calls: CallDto[] }> {
  const r = await fetch(`/api/positions?wallet=${wallet}`, { cache: "no-store" });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.message ?? "Could not load your calls.");
  }
  return r.json();
}

export function MyCalls({ refreshKey }: { refreshKey: number }) {
  const { address, isConnected } = useAccount();

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["positions", address, refreshKey],
    queryFn: () => fetchCalls(address!),
    enabled: Boolean(address),
    // A settlement should show up within a minute of the indexer knowing.
    refetchInterval: 15_000,
  });

  if (!isConnected) return null;

  return (
    <section aria-label="Your calls" className="mt-8">
      <h2 className="mb-3 text-sm font-medium text-ink">Your calls</h2>

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
      ) : !data || data.calls.length === 0 ? (
        <Card>
          <Empty
            title="No calls yet"
            hint="Place your first call above. It will appear here the moment the chain confirms it."
          />
        </Card>
      ) : (
        <Card className="divide-y divide-border">
          {data.calls.map((c) => (
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
        </Card>
      )}
    </section>
  );
}
