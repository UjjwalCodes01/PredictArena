"use client";

/**
 * A player's page. Also the share destination.
 *
 * Everything here is public chain-derived data keyed by address, so it works
 * for any wallet without that person having "signed up" -- the address IS the
 * identity (AGENTS.md non-goals: no accounts).
 */
import { use } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CallDto, StandingsResponse } from "@/lib/types";
import { amount, shortAddress, timeAgo } from "@/lib/format";
import { Card, Empty, ErrorNote, Skeleton, Stat, StatusPill } from "@/components/ui";

async function fetchCalls(wallet: string): Promise<{ calls: CallDto[] }> {
  const r = await fetch(`/api/positions?wallet=${wallet}`, { cache: "no-store" });
  if (!r.ok) throw new Error("Could not load this player's calls.");
  return r.json();
}

async function fetchStandings(): Promise<StandingsResponse> {
  const r = await fetch("/api/standings", { cache: "no-store" });
  if (!r.ok) throw new Error("Could not load the leaderboard.");
  return r.json();
}

export default function ProfilePage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = use(params);

  const calls = useQuery({ queryKey: ["positions", address], queryFn: () => fetchCalls(address) });
  const board = useQuery({ queryKey: ["standings", "current"], queryFn: fetchStandings });

  const standing = board.data?.standings.find(
    (s) => s.wallet.toLowerCase() === address.toLowerCase(),
  );

  return (
    <>
      <div className="mb-5">
        <p className="text-xs text-ink-faint">Player</p>
        <h1 className="tabular mt-0.5 text-xl font-semibold tracking-tight text-ink">
          {shortAddress(address)}
        </h1>
      </div>

      <Card className="mb-6 p-4">
        {board.isPending ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-3 w-12" />
                <Skeleton className="h-6 w-10" />
              </div>
            ))}
          </div>
        ) : standing ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Rank" value={`#${standing.rank}`} />
            <Stat label="Points" value={standing.points} />
            <Stat label="Record" value={`${standing.wins}-${standing.losses}`} />
            <Stat
              label="Accuracy"
              value={standing.calibration === null ? "—" : `${standing.calibration}%`}
            />
          </div>
        ) : (
          <p className="text-sm text-ink-soft">
            No scored calls this week yet. Settled calls appear on the board as they resolve.
          </p>
        )}
      </Card>

      <h2 className="mb-3 text-sm font-medium text-ink">Call history</h2>

      {calls.isPending ? (
        <Card className="divide-y divide-border">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center justify-between p-4">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-6 w-16" />
            </div>
          ))}
        </Card>
      ) : calls.isError ? (
        <ErrorNote
          title="Could not load this player's history."
          onRetry={() => void calls.refetch()}
        />
      ) : !calls.data || calls.data.calls.length === 0 ? (
        <Card>
          <Empty title="No calls yet" hint="This wallet has not placed a call." />
        </Card>
      ) : (
        <Card className="divide-y divide-border">
          {calls.data.calls.map((c) => (
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
    </>
  );
}
