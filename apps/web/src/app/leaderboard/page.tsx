"use client";

/**
 * The weekly board.
 *
 * Parameterised by week so a rollover cannot swap the table under the reader
 * mid-glance, and so a finished week stays readable after Monday. The reset
 * rule is stated on the page rather than assumed -- players need to know when
 * their streak stops counting.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useAccount } from "wagmi";
import type { StandingsResponse } from "@/lib/types";
import { shortAddress } from "@/lib/format";
import { Card, Empty, ErrorNote, Skeleton } from "@/components/ui";

async function fetchStandings(week?: string): Promise<StandingsResponse> {
  const r = await fetch(`/api/standings${week ? `?week=${week}` : ""}`, { cache: "no-store" });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.message ?? "Could not load the leaderboard.");
  }
  return r.json();
}

/** Step a week id back or forward without a date library. */
function shiftWeek(weekId: string, delta: number): string {
  const [y, w] = weekId.split("-W");
  const jan4 = Date.UTC(Number(y), 0, 4);
  const dow = new Date(jan4).getUTCDay() || 7;
  const monday = jan4 - (dow - 1) * 86_400_000 + (Number(w) - 1 + delta) * 7 * 86_400_000;
  const d = new Date(monday);
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() + 3);
  const isoYear = thursday.getUTCFullYear();
  const week = Math.ceil(((thursday.getTime() - Date.UTC(isoYear, 0, 1)) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

export default function LeaderboardPage() {
  const { address } = useAccount();
  const [week, setWeek] = useState<string | undefined>(undefined);

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["standings", week ?? "current"],
    queryFn: () => fetchStandings(week),
    refetchInterval: 20_000,
  });

  const currentWeek = data?.weekId;
  const me = address?.toLowerCase();

  return (
    <>
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">Leaderboard</h1>
          <p className="mt-1 text-sm text-ink-soft">
            {currentWeek ? `Week ${currentWeek.replace("-W", ", week ")}` : "This week"}
          </p>
        </div>
        <div className="flex gap-1">
          <button
            onClick={() => setWeek(shiftWeek(currentWeek ?? "", -1))}
            disabled={!currentWeek}
            className="rounded-md border border-border-strong px-2.5 py-1.5 text-sm text-ink-soft hover:text-ink disabled:opacity-45"
          >
            Previous
          </button>
          <button
            onClick={() => setWeek(undefined)}
            className="rounded-md border border-border-strong px-2.5 py-1.5 text-sm text-ink-soft hover:text-ink"
          >
            This week
          </button>
        </div>
      </div>

      {isPending ? (
        <Card className="divide-y divide-border">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-3 p-4">
              <Skeleton className="h-4 w-6" />
              <Skeleton className="h-4 w-32" />
              <Skeleton className="ml-auto h-4 w-12" />
            </div>
          ))}
        </Card>
      ) : isError ? (
        <ErrorNote
          title="Could not load the leaderboard."
          detail={error instanceof Error ? error.message : undefined}
          onRetry={() => void refetch()}
        />
      ) : !data || data.standings.length === 0 ? (
        <Card>
          <Empty
            title="No scores yet this week"
            hint="The board fills as calls settle. Place one and you will be the first name on it."
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="grid grid-cols-[2rem_1fr_auto] gap-3 border-b border-border px-4 py-2.5 text-xs text-ink-faint">
            <span>#</span>
            <span>Player</span>
            <span className="text-right">Points</span>
          </div>
          <ul className="divide-y divide-border">
            {data.standings.map((s) => {
              const isMe = me === s.wallet.toLowerCase();
              return (
                <li
                  key={s.wallet}
                  className={`grid grid-cols-[2rem_1fr_auto] items-center gap-3 px-4 py-3 ${
                    isMe ? "bg-accent-soft" : ""
                  }`}
                >
                  <span className="tabular text-sm text-ink-faint">{s.rank}</span>
                  <span className="min-w-0">
                    <Link
                      href={`/p/${s.wallet}`}
                      className="tabular block truncate text-sm font-medium text-ink hover:underline"
                    >
                      {shortAddress(s.wallet)}
                      {isMe ? <span className="ml-2 text-xs font-normal text-accent">You</span> : null}
                    </Link>
                    <span className="tabular mt-0.5 block text-xs text-ink-faint">
                      {s.wins}W {s.losses}L
                      {s.voids > 0 ? ` ${s.voids}V` : ""}
                      {s.currentStreak >= 2 ? ` · ${s.currentStreak} in a row` : ""}
                      {s.calibration !== null ? ` · ${s.calibration}% accurate` : ""}
                    </span>
                  </span>
                  <span className="tabular text-right text-sm font-semibold text-ink">{s.points}</span>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <p className="mt-4 text-xs text-ink-faint">
        A win scores 10 points, rising to 15 on a 3-win streak and 20 on 5. A void neither
        scores nor breaks a streak. Accuracy appears after 5 settled calls. The league resets
        every Monday at 00:00 UTC.
      </p>
    </>
  );
}
