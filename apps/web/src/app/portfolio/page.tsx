"use client";

/**
 * The connected player's own page.
 *
 * Its reason to exist is the claim prompt. Winnings are CLAIMED, not received:
 * a settled market pays out only when someone asks it to, so without this a
 * winning player's balance sits across finished windows while their wallet
 * reads unchanged, and the game looks like it does not pay.
 */
import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import Link from "next/link";
import type { CallDto, StandingsResponse } from "@/lib/types";
import { amount, timeAgo } from "@/lib/format";
import { PlayerIdentity } from "@/components/PlayerIdentity";
import { FormStrip } from "@/components/FormStrip";
import { Card, Empty, ErrorNote, Skeleton, Stat, StatusPill, Button } from "@/components/ui";
import { NetworkBanner } from "@/components/Wallet";

interface Claimable {
  total: string;
  positions: Array<{ marketId: string; outcomeIdx: 0 | 1; amount: string; estPayout: string }>;
}

export default function PortfolioPage() {
  const { address, isConnected } = useAccount();

  const calls = useQuery({
    queryKey: ["positions", address],
    queryFn: async (): Promise<{ calls: CallDto[] }> => {
      const r = await fetch(`/api/positions?wallet=${address}`, { cache: "no-store" });
      if (!r.ok) throw new Error("Could not load your calls.");
      return r.json();
    },
    enabled: Boolean(address),
    refetchInterval: 15_000,
  });

  const board = useQuery({
    queryKey: ["standings", "current"],
    queryFn: async (): Promise<StandingsResponse> => {
      const r = await fetch("/api/standings", { cache: "no-store" });
      if (!r.ok) throw new Error("Could not load the leaderboard.");
      return r.json();
    },
  });

  const claimable = useQuery({
    queryKey: ["claimable", address],
    queryFn: async (): Promise<Claimable> => {
      const r = await fetch(`/api/claimable?wallet=${address}`, { cache: "no-store" });
      if (!r.ok) throw new Error("Could not check unclaimed winnings.");
      return r.json();
    },
    enabled: Boolean(address),
    retry: 0,
  });

  if (!isConnected || !address) {
    return (
      <Card>
        <Empty
          image="/img/office-window.jpg"
          title="Connect a wallet to see your calls"
          hint="Your record, your rank and anything you have won will appear here."
        />
      </Card>
    );
  }

  const standing = board.data?.standings.find(
    (s) => s.wallet.toLowerCase() === address.toLowerCase(),
  );
  const unclaimed = claimable.data && BigInt(claimable.data.total) > 0n;

  return (
    <>
      <NetworkBanner />

      <div className="mb-4">
        <h1 className="mb-2 text-xl font-semibold tracking-tight text-ink">Your calls</h1>
        <PlayerIdentity address={address} size={36} link={false} />
      </div>

      {unclaimed ? (
        <div className="mb-4 rounded-lg border border-up/40 bg-up-soft px-4 py-3">
          <p className="text-sm font-medium text-ink">
            You have {amount(claimable.data!.total, 2)} tUSDC waiting
          </p>
          <p className="mt-1 text-sm text-ink-soft">
            Winnings are claimed, not sent automatically. Redeeming moves them to your wallet.
          </p>
          <Link href="/how-it-works#claiming">
            <Button variant="secondary" className="mt-2">
              How claiming works
            </Button>
          </Link>
        </div>
      ) : null}

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
            You have no scored calls this week yet. Your first settled call puts you on the board.
          </p>
        )}
      </Card>

      {calls.data && calls.data.calls.filter((c) => c.status !== "PENDING").length > 0 ? (
        <Card className="mb-4 p-4">
          <p className="mb-2 text-xs text-ink-faint">Recent form, newest first</p>
          <FormStrip calls={calls.data.calls.filter((c) => c.status !== "PENDING").slice(0, 12)} />
        </Card>
      ) : null}

      <h2 className="label mb-2">HISTORY</h2>

      {calls.isPending ? (
        <Card className="divide-y divide-border">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center justify-between p-4">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-6 w-16" />
            </div>
          ))}
        </Card>
      ) : calls.isError ? (
        <ErrorNote title="Could not load your history." onRetry={() => void calls.refetch()} />
      ) : !calls.data || calls.data.calls.length === 0 ? (
        <Card>
          <Empty
            title="No calls yet"
            hint="Head to Play and make your first call."
            action={
              <Link href="/">
                <Button>Place a call</Button>
              </Link>
            }
          />
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
