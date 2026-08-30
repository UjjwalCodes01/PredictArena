"use client";

/**
 * A player's full record.
 *
 * Everything is public chain-derived data keyed by address, so it works for any
 * wallet without that person having signed up -- the address IS the identity.
 * The owner gets one extra thing: the ability to put a name on it, proved by a
 * signature.
 */
import { use } from "react";
import { useQuery } from "@tanstack/react-query";
import Image from "next/image";
import { useAccount } from "wagmi";
import type { CallDto, StandingsResponse, ProfileDto } from "@/lib/types";
import { amount, shortAddress, timeAgo } from "@/lib/format";
import { Avatar } from "@/components/Avatar";
import { ShareButton } from "@/components/ShareButton";
import Link from "next/link";
import { CopyAddress } from "@/components/CopyAddress";
import { FormStrip } from "@/components/FormStrip";
import { Card, Empty, ErrorNote, Skeleton, Stat, StatusPill } from "@/components/ui";

export default function ProfilePage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = use(params);
  const { address: connected } = useAccount();
  const isOwner = connected?.toLowerCase() === address.toLowerCase();

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
  const bio = profile.data?.bio ?? null;
  const twitter = profile.data?.twitter ?? null;
  const website = profile.data?.website ?? null;
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

        {/* The avatar overlaps the banner; the text sits below it so a long
            name can never be clipped by the image above. */}
        <div className="px-4 pb-4">
          <div className="-mt-7 flex items-end justify-between gap-3">
            <Avatar address={address} size={60} className="ring-4 ring-surface" />
            <ShareButton address={address} />
          </div>
          <h1 className="mt-2 break-words text-lg font-bold uppercase tracking-tight text-ink">
            {name ?? shortAddress(address)}
          </h1>
          <CopyAddress address={address} />
        </div>

        {bio || twitter || website ? (
          <div className="space-y-2 border-t border-border p-4">
            {bio ? (
              // Rendered as text, never as markup: React escapes it, and the
              // server already refused anything but an http(s) link below.
              <p className="text-sm leading-relaxed text-ink-soft">{bio}</p>
            ) : null}
            {twitter || website ? (
              <div className="flex flex-wrap items-center gap-4">
                {twitter ? (
                  <a
                    href={`https://x.com/${twitter}`}
                    target="_blank"
                    rel="noreferrer noopener nofollow"
                    className="label text-accent hover:brightness-125"
                  >
                    @{twitter}
                  </a>
                ) : null}
                {website ? (
                  <a
                    href={website}
                    target="_blank"
                    rel="noreferrer noopener nofollow"
                    className="label max-w-full truncate text-accent hover:brightness-125"
                  >
                    {website.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                  </a>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {isOwner ? (
          <div className="border-t border-border p-4">
            <Link href="/settings" className="label text-accent hover:brightness-125">
              [ EDIT YOUR PROFILE ]
            </Link>
          </div>
        ) : null}
      </Card>

      {/* This week */}
      <h2 className="label mb-2">THIS WEEK</h2>
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
      <h2 className="label mb-2">ALL TIME</h2>
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

      <h2 className="label mb-2">CALL HISTORY</h2>
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
