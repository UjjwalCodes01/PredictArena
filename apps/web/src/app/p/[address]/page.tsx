"use client";

/**
 * A player's full record.
 *
 * Everything is public chain-derived data keyed by address, so it works for any
 * wallet without that person having signed up -- the address IS the identity.
 * The owner gets one extra thing: the ability to put a name on it, proved by a
 * signature.
 */
import { use, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Image from "next/image";
import { useAccount } from "wagmi";
import type { CallDto, StandingsResponse, ProfileDto } from "@/lib/types";
import { amount, shortAddress, timeAgo } from "@/lib/format";
import { Avatar } from "@/components/Avatar";
import { ShareButton } from "@/components/ShareButton";
import { ClaimNameForm } from "@/components/ClaimNameForm";
import { CopyAddress } from "@/components/CopyAddress";
import { FormStrip } from "@/components/FormStrip";
import { Card, Empty, ErrorNote, Skeleton, Stat, StatusPill } from "@/components/ui";

export default function ProfilePage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = use(params);
  const { address: connected } = useAccount();
  const isOwner = connected?.toLowerCase() === address.toLowerCase();
  const [editing, setEditing] = useState(false);

  const profile = useQuery({
    queryKey: ["profile", address],
    queryFn: async (): Promise<ProfileDto> => {
      const r = await fetch(`/api/profile?wallet=${address}`, { cache: "no-store" });
      if (!r.ok) throw new Error("Could not load that profile.");
      return r.json();
    },
  });

  const calls = useQuery({
    queryKey: ["positions", address],
    queryFn: async (): Promise<{ calls: CallDto[] }> => {
      const r = await fetch(`/api/positions?wallet=${address}`, { cache: "no-store" });
      if (!r.ok) throw new Error("Could not load this player's calls.");
      return r.json();
    },
  });

  const board = useQuery({
    queryKey: ["standings", "current"],
    queryFn: async (): Promise<StandingsResponse> => {
      const r = await fetch("/api/standings", { cache: "no-store" });
      if (!r.ok) throw new Error("Could not load the leaderboard.");
      return r.json();
    },
  });

  const standing = board.data?.standings.find(
    (s) => s.wallet.toLowerCase() === address.toLowerCase(),
  );
  const name = profile.data?.displayName ?? null;
  const list = calls.data?.calls ?? [];

  // Staked and won are summed as bigint: an amount must never pass through a
  // JSON number on its way to being displayed.
  const staked = list.reduce((sum, c) => sum + BigInt(c.stake), 0n);
  const settled = list.filter((c) => c.status !== "PENDING");
  const pending = list.filter((c) => c.status === "PENDING").length;

  return (
    <>
      {/* Banner: a face for the page, and a place for the name and share action. */}
      <Card className="mb-4 overflow-hidden">
        <div className="relative h-24 w-full">
          <Image
            src="/img/chain-network-dark.jpg"
            alt=""
            fill
            sizes="(max-width: 672px) 100vw, 672px"
            className="object-cover"
          />
          <div className="absolute inset-0 bg-black/45" />
        </div>

        <div className="-mt-8 flex items-end justify-between gap-3 px-4 pb-4">
          <div className="flex min-w-0 items-end gap-3">
            <Avatar address={address} size={64} className="ring-4 ring-surface" />
            <div className="min-w-0 pb-1">
              <h1 className="truncate text-lg font-semibold tracking-tight text-ink">
                {name ?? shortAddress(address)}
              </h1>
              <CopyAddress address={address} />
            </div>
          </div>
          <div className="pb-1">
            <ShareButton address={address} />
          </div>
        </div>

        {isOwner ? (
          <div className="border-t border-border p-4">
            {editing || !name ? (
              <ClaimNameForm
                currentName={name}
                onSaved={() => {
                  setEditing(false);
                  void profile.refetch();
                }}
              />
            ) : (
              <button
                onClick={() => setEditing(true)}
                className="text-sm font-medium text-accent underline underline-offset-2"
              >
                Change your name
              </button>
            )}
          </div>
        ) : null}
      </Card>

      {/* This week */}
      <h2 className="mb-2 text-sm font-medium text-ink">This week</h2>
      <Card className="mb-4 p-4">
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
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Rank" value={`#${standing.rank}`} />
              <Stat label="Points" value={standing.points} />
              <Stat label="Record" value={`${standing.wins}-${standing.losses}`} />
              <Stat
                label="Accuracy"
                value={standing.calibration === null ? "—" : `${standing.calibration}%`}
              />
            </div>
            <div className="mt-4 grid grid-cols-2 gap-4 border-t border-border pt-4 sm:grid-cols-4">
              <Stat label="Current streak" value={standing.currentStreak} />
              <Stat label="Best streak" value={standing.bestStreak} />
              <Stat label="Voided" value={standing.voids} />
              <Stat label="Settled" value={standing.settled} />
            </div>
          </>
        ) : (
          <p className="text-sm text-ink-soft">
            No scored calls this week. A settled call puts this wallet on the board.
          </p>
        )}
      </Card>

      {/* All time, from the call history we hold */}
      <h2 className="mb-2 text-sm font-medium text-ink">All time</h2>
      <Card className="mb-4 p-4">
        {calls.isPending ? (
          <Skeleton className="h-12 w-full" />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Calls" value={list.length} />
              <Stat label="Settled" value={settled.length} />
              <Stat label="Open" value={pending} />
              <Stat label="Staked" value={amount(staked, 2)} unit="tUSDC" />
            </div>
            {settled.length > 0 ? (
              <div className="mt-4 border-t border-border pt-4">
                <p className="mb-2 text-xs text-ink-faint">Recent form, newest first</p>
                <FormStrip calls={settled.slice(0, 12)} />
              </div>
            ) : null}
            {profile.data?.firstSeenAt ? (
              <p className="mt-4 border-t border-border pt-4 text-xs text-ink-faint">
                First seen {timeAgo(profile.data.firstSeenAt)}
              </p>
            ) : null}
          </>
        )}
      </Card>

      <h2 className="mb-2 text-sm font-medium text-ink">Call history</h2>
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
        <ErrorNote title="Could not load this player's history." onRetry={() => void calls.refetch()} />
      ) : list.length === 0 ? (
        <Card>
          <Empty title="No calls yet" hint="This wallet has not placed a call." />
        </Card>
      ) : (
        <Card className="divide-y divide-border">
          {list.map((c) => (
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
