"use client";

/**
 * What sits beside the call flow.
 *
 * Connected, that is your own record. Disconnected, an empty column beside a
 * live market reads as a broken layout, so it shows this week's leaders
 * instead: it fills the space with something true, and seeing real names on a
 * board is a better argument for connecting than a button that says "connect".
 */
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useAccount } from "wagmi";
import type { StandingsResponse } from "@/lib/types";
import { PlayerIdentity } from "./PlayerIdentity";
import { MyCalls } from "./MyCalls";
import { Panel, Skeleton, Empty } from "./ui";
import { ConnectButton } from "./Wallet";

export function SidePanel({ refreshKey }: { refreshKey: number }) {
  const { isConnected } = useAccount();
  if (isConnected) return <MyCalls refreshKey={refreshKey} />;
  return <LeadersPreview />;
}

function LeadersPreview() {
  const { data, isPending, isError } = useQuery({
    queryKey: ["standings", "current"],
    queryFn: async (): Promise<StandingsResponse> => {
      const r = await fetch("/api/standings", { cache: "no-store" });
      if (!r.ok) throw new Error("Could not load the leaderboard.");
      return r.json();
    },
    refetchInterval: 30_000,
  });

  const top = data?.standings.slice(0, 6) ?? [];

  return (
    <div className="space-y-3">
      <Panel label="CONNECT TO PLAY" bodyClass="p-4">
        <p className="text-sm text-ink-soft">
          Your wallet is the account — there is no sign-up. Everything below is real testnet
          activity from other players.
        </p>
        <div className="mt-3">
          <ConnectButton />
        </div>
      </Panel>

      <Panel
        label="THIS WEEK'S LEADERS"
        aside={
          data ? <span className="tabular text-xs text-ink-soft">{data.standings.length}</span> : null
        }
        bodyClass="p-0"
      >
        {isPending ? (
          <div className="space-y-3 p-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-8 w-8 rounded-full" />
                <Skeleton className="h-4 w-28" />
                <Skeleton className="ml-auto h-4 w-8" />
              </div>
            ))}
          </div>
        ) : isError || top.length === 0 ? (
          <Empty
            title="No scores yet this week"
            hint="The board fills as calls settle."
          />
        ) : (
          <ul className="divide-y divide-border">
            {top.map((s) => (
              <li key={s.wallet} className="flex items-center gap-3 px-4 py-2.5">
                <span className="tabular w-5 shrink-0 text-xs text-ink-faint">{s.rank}</span>
                <div className="min-w-0 flex-1">
                  <PlayerIdentity address={s.wallet} displayName={s.displayName} size={26} />
                </div>
                <span className="tabular shrink-0 text-sm font-semibold text-ink">{s.points}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="border-t border-border px-4 py-2.5">
          <Link href="/leaderboard" className="label text-accent hover:brightness-125">
            [ FULL LEADERBOARD ]
          </Link>
        </div>
      </Panel>
    </div>
  );
}
