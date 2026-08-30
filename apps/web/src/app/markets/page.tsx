"use client";

/**
 * Every live window, across both assets and all series.
 *
 * The Play page deliberately shows ONE window so a decision is easy. This page
 * is the opposite view for someone who wants to choose: which asset, which
 * length, and where anyone is actually quoting.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import Image from "next/image";
import type { WindowsResponse, WindowDto } from "@/lib/types";
import { countdown, percent, seriesLabel } from "@/lib/format";
import { useServerClock, useTick } from "@/hooks/useServerClock";
import { Card, Empty, ErrorNote, Skeleton } from "@/components/ui";

async function fetchAll(): Promise<WindowsResponse> {
  const r = await fetch("/api/windows", { cache: "no-store" });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.message ?? "Could not load markets.");
  }
  return r.json();
}

const FILTERS = ["All", "BTC", "ETH"] as const;

/** One recognisable image per asset, so a long list is scannable at a glance. */
const ASSET_IMAGE: Record<string, string> = {
  BTC: "/img/btc-coin-gold.jpg",
  ETH: "/img/eth-abstract.jpg",
};
const FALLBACK_IMAGE = "/img/data-abstract.jpg";

export default function MarketsPage() {
  const [asset, setAsset] = useState<(typeof FILTERS)[number]>("All");
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["windows", "all"],
    queryFn: fetchAll,
    refetchInterval: 10_000,
  });

  const now = useServerClock(data?.serverNowSec);
  useTick(Boolean(data));

  const rows: WindowDto[] = (data?.windows ?? [])
    .filter((w) => asset === "All" || w.asset === asset)
    .sort((a, b) => a.closesAtSec - b.closesAtSec);

  return (
    <>
      <div className="mb-4 overflow-hidden rounded-xl border border-border">
        <div className="relative h-28 w-full sm:h-32">
          <Image src="/img/btc-on-chart.jpg" alt="" fill priority sizes="(max-width: 672px) 100vw, 672px" className="object-cover" />
          <div className="absolute inset-0 bg-black/55" />
          <div className="absolute inset-0 flex flex-col justify-end p-4">
            <h1 className="text-xl font-semibold tracking-tight text-white">Markets</h1>
            <p className="mt-0.5 text-sm text-white/80">
              Every open window. Shorter ones settle sooner.
            </p>
          </div>
        </div>
      </div>

      <div className="mb-3 flex gap-1" role="group" aria-label="Filter by asset">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setAsset(f)}
            aria-pressed={asset === f}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              asset === f ? "bg-ink text-bg" : "text-ink-soft hover:text-ink"
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {isPending ? (
        <Card className="divide-y divide-border">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center justify-between p-4">
              <div className="space-y-2">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-3 w-20" />
              </div>
              <Skeleton className="h-8 w-24" />
            </div>
          ))}
        </Card>
      ) : isError ? (
        <ErrorNote
          title="Could not load markets."
          detail={error instanceof Error ? error.message : undefined}
          onRetry={() => void refetch()}
        />
      ) : rows.length === 0 ? (
        <Card>
          <Empty
            title="No open windows right now"
            hint="Windows open on a schedule. The next one is usually seconds away."
          />
        </Card>
      ) : (
        <Card className="divide-y divide-border">
          {rows.map((w) => {
            const left = w.closesAtSec - now() / 1000;
            return (
              <div key={w.marketId} className="flex items-center justify-between gap-3 p-4">
                <div className="flex min-w-0 items-center gap-3">
                  <Image
                    src={ASSET_IMAGE[w.asset] ?? FALLBACK_IMAGE}
                    alt=""
                    width={40}
                    height={40}
                    className="h-10 w-10 shrink-0 rounded-lg object-cover"
                  />
                  <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">
                    {w.asset} · {seriesLabel(w.intervalSec)}
                  </p>
                  <p className="tabular mt-0.5 text-xs text-ink-faint">
                    {left > 0 ? `closes in ${countdown(left)}` : "closing"}
                    {!w.isTradable ? " · not accepting calls" : ""}
                  </p>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-4">
                  <div className="text-right">
                    <p className="text-xs text-ink-faint">Up</p>
                    <p className="tabular text-sm font-medium text-up">
                      {w.upPrice ? percent(BigInt(w.upPrice)) : "—"}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-ink-faint">Down</p>
                    <p className="tabular text-sm font-medium text-down">
                      {w.downPrice ? percent(BigInt(w.downPrice)) : "—"}
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </Card>
      )}

      <p className="mt-4 text-xs text-ink-faint">
        Percentages are the market&apos;s implied chance of that outcome, and also what one contract
        costs. A winning contract pays 1 tUSDC.{" "}
        <Link href="/how-it-works" className="text-accent underline underline-offset-2">
          How it works
        </Link>
      </p>
    </>
  );
}
