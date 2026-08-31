"use client";

/**
 * The weekly board.
 *
 * Parameterised by week so a rollover cannot swap the table under the reader,
 * and searchable because a league of a hundred players is useless if you cannot
 * find yourself in it.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Image from "next/image";
import { useAccount } from "wagmi";
import type { StandingsResponse } from "@/lib/types";
import { PlayerIdentity } from "@/components/PlayerIdentity";
import { Card, Empty, ErrorNote, Skeleton } from "@/components/ui";

async function fetchStandings(week?: string): Promise<StandingsResponse> {
  const r = await fetch(`/api/standings${week ? `?week=${week}` : ""}`, { cache: "no-store" });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.message ?? "Could not load the leaderboard.");
  }
  return r.json();
}

/** Step a week id without pulling in a date library. */
function shiftWeek(weekId: string, delta: number): string {
  const [y, w] = weekId.split("-W");
  const jan4 = Date.UTC(Number(y), 0, 4);
  const dow = new Date(jan4).getUTCDay() || 7;
  const monday = jan4 - (dow - 1) * 86_400_000 + (Number(w) - 1 + delta) * 7 * 86_400_000;
  const thursday = new Date(monday + 3 * 86_400_000);
  const isoYear = thursday.getUTCFullYear();
  const week = Math.ceil(((thursday.getTime() - Date.UTC(isoYear, 0, 1)) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

export default function LeaderboardPage() {
  const { address } = useAccount();
  const [week, setWeek] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState("");

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["standings", week ?? "current"],
    queryFn: () => fetchStandings(week),
    refetchInterval: 20_000,
  });

  const me = address?.toLowerCase();
  const rows = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    if (!q) return data.standings;
    return data.standings.filter(
      (s) => s.wallet.toLowerCase().includes(q) || (s.displayName ?? "").toLowerCase().includes(q),
    );
  }, [data, search]);

  const myRow = data?.standings.find((s) => s.wallet.toLowerCase() === me);

  return (
    <>
      <div className="mb-4 overflow-hidden rounded-xl border border-border">
        <div className="relative h-28 w-full sm:h-32 lg:h-40">
          <Image
            src="/img/finance-district.jpg"
            alt=""
            fill
            priority
            sizes="(max-width: 672px) 100vw, 672px"
            className="object-cover"
          />
          <div className="absolute inset-0 bg-black/55" />
          <div className="absolute inset-0 flex flex-col justify-end p-4">
            <h1 className="text-xl font-semibold tracking-tight text-white">Leaderboard</h1>
            <p className="mt-0.5 text-sm text-white/80">
              {data ? `Week ${data.weekId}` : "This week"}
              {data ? ` · ${data.standings.length} players` : ""}
            </p>
          </div>
        </div>
      </div>

      {myRow ? (
        <Card className="mb-3 border-accent/40 bg-accent-soft p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="tabular w-8 text-sm text-ink-soft">#{myRow.rank}</span>
            <div className="min-w-0 flex-1">
              <PlayerIdentity address={myRow.wallet} displayName={myRow.displayName} you link={false} />
            </div>
            <span className="tabular text-sm font-semibold text-ink">{myRow.points}</span>
          </div>
        </Card>
      ) : null}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name or address"
          aria-label="Search players"
          className="min-w-0 flex-1 rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint"
        />
        <div className="flex gap-1">
          <button
            onClick={() => setWeek(shiftWeek(data?.weekId ?? "", -1))}
            disabled={!data}
            className="rounded-md border border-border-strong px-2.5 py-2 text-sm text-ink-soft hover:text-ink disabled:opacity-45"
          >
            Previous
          </button>
          <button
            onClick={() => setWeek(undefined)}
            className="rounded-md border border-border-strong px-2.5 py-2 text-sm text-ink-soft hover:text-ink"
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
              <Skeleton className="h-8 w-8 rounded-full" />
              <Skeleton className="h-4 w-32" />
              <Skeleton className="ml-auto h-4 w-10" />
            </div>
          ))}
        </Card>
      ) : isError ? (
        <ErrorNote
          title="Could not load the leaderboard."
          detail={error instanceof Error ? error.message : undefined}
          onRetry={() => void refetch()}
        />
      ) : rows.length === 0 ? (
        <Card>
          <Empty
            title={search ? "No player matches that" : "No scores yet this week"}
            hint={
              search
                ? "Try part of an address, or a name."
                : "The board fills as calls settle. Place one and you will be first on it."
            }
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          {/* Column names belong once, at the top. Repeating them on every row
              turned a 146-row table into 438 redundant words. */}
          <div className="hidden items-center gap-3 border-b border-border px-4 py-2 md:flex">
            <span className="label w-6">#</span>
            <span className="label flex-1">PLAYER</span>
            <span className="label w-14 text-right">W-L</span>
            <span className="label w-14 text-right">STREAK</span>
            <span className="label w-20 text-right">ACCURACY</span>
            <span
              className="label w-16 text-right"
              title="Realized win rate minus the price you paid. Positive means you find sides the market underprices."
            >
              EDGE
            </span>
            <span className="label w-12 text-right">POINTS</span>
          </div>
          <ul className="divide-y divide-border">
            {rows.map((s) => (
              <li
                key={s.wallet}
                className={`flex items-center gap-3 px-4 py-3 ${
                  me === s.wallet.toLowerCase() ? "bg-accent-soft" : ""
                }`}
              >
                <span className="tabular w-6 shrink-0 text-sm text-ink-faint">{s.rank}</span>
                <div className="min-w-0 flex-1">
                  <PlayerIdentity
                    address={s.wallet}
                    displayName={s.displayName}
                    you={me === s.wallet.toLowerCase()}
                  />
                  {/* Below md the stats read as one line under the name; from md
                      up they become their own columns, which is what the extra
                      width is for. */}
                  <p className="tabular mt-1 text-xs text-ink-faint md:hidden">
                    {s.wins}W {s.losses}L
                    {s.voids > 0 ? ` ${s.voids}V` : ""}
                    {s.currentStreak >= 2 ? ` · ${s.currentStreak} in a row` : ""}
                    {s.calibration !== null ? ` · ${s.calibration}% accurate` : ""}
                    {s.edge !== null ? ` · ${s.edge > 0 ? "+" : ""}${s.edge} edge` : ""}
                  </p>
                </div>

                <span className="tabular hidden w-14 shrink-0 text-right text-sm text-ink-soft md:block">
                  {s.wins}-{s.losses}
                </span>
                <span className="tabular hidden w-14 shrink-0 text-right text-sm text-ink-soft md:block">
                  {s.currentStreak >= 2 ? s.currentStreak : "—"}
                </span>
                <span className="tabular hidden w-20 shrink-0 text-right text-sm text-ink-soft md:block">
                  {s.calibration === null ? "—" : `${s.calibration}%`}
                </span>
                {/* Sign carries the meaning, so it is stated with a + or - and
                    coloured — never colour alone. */}
                <span
                  className={`tabular hidden w-16 shrink-0 text-right text-sm md:block ${
                    s.edge === null ? "text-ink-soft" : s.edge > 0 ? "text-up" : s.edge < 0 ? "text-down" : "text-ink-soft"
                  }`}
                  title={
                    s.edge === null
                      ? "Needs 5 settled calls"
                      : `Won ${s.calibration}% while paying an average of ${s.avgImplied}%`
                  }
                >
                  {s.edge === null ? "—" : `${s.edge > 0 ? "+" : ""}${s.edge}`}
                </span>

                <span className="tabular w-12 shrink-0 text-right text-sm font-semibold text-ink">
                  {s.points}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <p className="mt-4 text-xs text-ink-faint">
        A win scores 10 points, rising to 15 on a 3-win streak and 20 on 5. A void neither scores nor
        breaks a streak. The league resets every Monday at 00:00 UTC.
        {" "}
        <strong className="text-ink">Edge</strong> is the honest one: your win rate minus the price
        you paid. Anyone can win a coin flip — a positive edge means you are finding sides the
        market has underpriced. Both it and accuracy appear after 5 settled calls.
      </p>
    </>
  );
}

