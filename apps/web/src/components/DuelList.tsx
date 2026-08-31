"use client";

/**
 * A wallet's duels, and its head-to-head record.
 *
 * Every state here is derived from calls at read time, so this list cannot
 * disagree with the leaderboard. States say plainly what happened, including
 * the unglamorous ones: a challenge nobody accepted reads as EXPIRED, not as a
 * win for whoever turned up.
 */
import { useQuery } from "@tanstack/react-query";
import { PlayerIdentity } from "./PlayerIdentity";
import { Panel, Empty, ErrorNote, Skeleton, Stat } from "./ui";
import { seriesLabel } from "@/lib/format";

interface DuelDto {
  id: string;
  challenger: string;
  opponent: string;
  windowId: string;
  asset: string | null;
  intervalSec: number | null;
  closesAtSec: number;
  createdAt: string;
  state: "OPEN" | "EXPIRED" | "VOID" | "RESOLVED";
  result: "CHALLENGER" | "OPPONENT" | "DRAW" | null;
}

interface DuelsResponse {
  duels: DuelDto[];
  record: { won: number; lost: number; drawn: number; open: number; expired: number };
}

/** What this duel means for the wallet whose page we are on. */
function verdict(d: DuelDto, me: string): { text: string; cls: string } {
  const isChallenger = d.challenger.toLowerCase() === me.toLowerCase();
  switch (d.state) {
    case "OPEN":
      return { text: "OPEN", cls: "border-border-strong text-ink-soft" };
    case "EXPIRED":
      return { text: "EXPIRED", cls: "border-border-strong bg-surface-2 text-ink-faint" };
    case "VOID":
      return { text: "VOID", cls: "border-border-strong bg-surface-2 text-ink-soft" };
    case "RESOLVED": {
      if (d.result === "DRAW") return { text: "DRAW", cls: "border-border-strong text-ink-soft" };
      const won = (d.result === "CHALLENGER") === isChallenger;
      return won
        ? { text: "WON", cls: "border-up/50 bg-up-soft text-up" }
        : { text: "LOST", cls: "border-down/50 bg-down-soft text-down" };
    }
  }
}

export function DuelList({ wallet }: { wallet: string }) {
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ["duels", wallet],
    queryFn: async (): Promise<DuelsResponse> => {
      const r = await fetch(`/api/duels?wallet=${wallet}`, { cache: "no-store" });
      if (!r.ok) throw new Error("Could not load duels.");
      return r.json();
    },
    refetchInterval: 30_000,
  });

  if (isPending) {
    return (
      <Panel label="HEAD TO HEAD" bodyClass="p-4">
        <Skeleton className="h-16 w-full" />
      </Panel>
    );
  }
  if (isError) {
    return (
      <Panel label="HEAD TO HEAD" bodyClass="p-4">
        <ErrorNote title="Could not load duels." onRetry={() => void refetch()} />
      </Panel>
    );
  }

  const { duels, record } = data;

  return (
    <Panel
      label="HEAD TO HEAD"
      aside={
        duels.length > 0 ? (
          <span className="tabular text-xs text-ink-soft">
            {record.won}W {record.lost}L {record.drawn}D
          </span>
        ) : null
      }
      bodyClass="p-0"
    >
      {duels.length === 0 ? (
        <Empty
          title="No duels yet"
          hint="Challenge another player and you both call the same window. Whoever gets it right wins."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 border-b border-border p-4 sm:grid-cols-4">
            <Stat label="Won" value={record.won} tone={record.won > 0 ? "up" : "default"} />
            <Stat label="Lost" value={record.lost} tone={record.lost > 0 ? "down" : "default"} />
            <Stat label="Drawn" value={record.drawn} />
            <Stat label="Open" value={record.open} />
          </div>
          <ul className="divide-y divide-border">
            {duels.map((d) => {
              const isChallenger = d.challenger.toLowerCase() === wallet.toLowerCase();
              const other = isChallenger ? d.opponent : d.challenger;
              const v = verdict(d, wallet);
              return (
                <li key={d.id} className="flex items-center justify-between gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <PlayerIdentity address={other} size={28} />
                    <p className="tabular mt-1 text-xs text-ink-faint">
                      {isChallenger ? "challenged" : "challenged you"} ·{" "}
                      {d.asset ?? "?"} {seriesLabel(d.intervalSec)}
                    </p>
                  </div>
                  <span
                    className={`inline-flex shrink-0 rounded-sm border px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[0.625rem] font-medium uppercase tracking-wider ${v.cls}`}
                  >
                    {v.text}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Panel>
  );
}
