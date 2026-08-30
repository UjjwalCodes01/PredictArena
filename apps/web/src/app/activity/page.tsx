"use client";

/**
 * What everyone is doing.
 *
 * A league needs to feel inhabited -- a board with names but no motion reads as
 * abandoned. This is the same public chain data as everything else, arranged so
 * the room looks occupied.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Image from "next/image";
import type { CallDto } from "@/lib/types";
import { amount, timeAgo } from "@/lib/format";
import { PlayerIdentity } from "@/components/PlayerIdentity";
import { Card, Empty, ErrorNote, Skeleton, Stat, StatusPill } from "@/components/ui";

interface ActivityResponse {
  weekId: string;
  totals: { players: number; calls: number; settled: number; volume: string };
  calls: CallDto[];
}

async function fetchActivity(settledOnly: boolean): Promise<ActivityResponse> {
  const r = await fetch(`/api/activity${settledOnly ? "?settled=1" : ""}`, { cache: "no-store" });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.message ?? "Could not load activity.");
  }
  return r.json();
}

export default function ActivityPage() {
  const [settledOnly, setSettledOnly] = useState(false);
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["activity", settledOnly],
    queryFn: () => fetchActivity(settledOnly),
    refetchInterval: 15_000,
  });

  return (
    <>
      <div className="mb-4 overflow-hidden rounded-xl border border-border">
        <div className="relative h-28 w-full sm:h-32">
          <Image src="/img/trader-desk.jpg" alt="" fill priority sizes="(max-width: 672px) 100vw, 672px" className="object-cover" />
          <div className="absolute inset-0 bg-black/55" />
          <div className="absolute inset-0 flex flex-col justify-end p-4">
            <h1 className="text-xl font-semibold tracking-tight text-white">Activity</h1>
            <p className="mt-0.5 text-sm text-white/80">
              Every call in the league this week, newest first.
            </p>
          </div>
        </div>
      </div>

      <Card className="mb-4 p-4">
        {isPending ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-3 w-14" />
                <Skeleton className="h-6 w-12" />
              </div>
            ))}
          </div>
        ) : data ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Players" value={data.totals.players} />
            <Stat label="Calls" value={data.totals.calls} />
            <Stat label="Settled" value={data.totals.settled} />
            <Stat label="Staked" value={amount(data.totals.volume, 0)} unit="tUSDC" />
          </div>
        ) : null}
      </Card>

      <div className="mb-3 flex gap-1" role="group" aria-label="Filter">
        <button
          onClick={() => setSettledOnly(false)}
          aria-pressed={!settledOnly}
          className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
            !settledOnly ? "bg-ink text-bg" : "text-ink-soft hover:text-ink"
          }`}
        >
          All
        </button>
        <button
          onClick={() => setSettledOnly(true)}
          aria-pressed={settledOnly}
          className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
            settledOnly ? "bg-ink text-bg" : "text-ink-soft hover:text-ink"
          }`}
        >
          Settled only
        </button>
      </div>

      {isPending ? (
        <Card className="divide-y divide-border">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center justify-between p-4">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-6 w-16" />
            </div>
          ))}
        </Card>
      ) : isError ? (
        <ErrorNote
          title="Could not load activity."
          detail={error instanceof Error ? error.message : undefined}
          onRetry={() => void refetch()}
        />
      ) : !data || data.calls.length === 0 ? (
        <Card>
          <Empty
            image="/img/dashboard-screen.jpg"
            title="Nothing yet this week"
            hint="Calls appear here as soon as the chain confirms them."
          />
        </Card>
      ) : (
        <Card className="divide-y divide-border lg:grid lg:grid-cols-2 lg:divide-y-0">
          {data.calls.map((c) => (
            <div
              key={c.id}
              className="flex items-center justify-between gap-3 border-b border-border p-4 last:border-b-0 lg:border-r lg:[&:nth-child(2n)]:border-r-0"
            >
              <div className="min-w-0 flex-1">
                <PlayerIdentity address={c.wallet} displayName={c.displayName} size={28} />
                <p className="tabular mt-1 text-xs text-ink-faint">
                  called {c.asset} {c.direction === "UP" ? "Up" : "Down"} · {amount(c.stake, 2)} tUSDC ·{" "}
                  {timeAgo(c.settledAt ?? c.placedAt)}
                </p>
              </div>
              <StatusPill status={c.status} />
            </div>
          ))}
        </Card>
      )}
    </>
  );
}
