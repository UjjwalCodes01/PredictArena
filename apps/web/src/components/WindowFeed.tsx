"use client";

/**
 * The windows feed and the live call flow.
 *
 * Deliberately shows ONE window at a time -- the next one to settle for the
 * chosen asset. A grid of every open window is more information than a decision
 * needs, and the whole point of the product is a one-tap call.
 */
import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { WindowsResponse, WindowDto } from "@/lib/types";
import { countdown, seriesLabel } from "@/lib/format";
import { useServerClock, useTick } from "@/hooks/useServerClock";
import { CallPanel } from "./CallPanel";
import { Card, Panel, ErrorNote, Skeleton, Empty, LiveDot } from "./ui";

const ASSETS = ["BTC", "ETH"] as const;
/** The 5-minute series: long enough to decide, short enough to see it settle. */
const PREFERRED_INTERVAL = 300;

async function fetchWindows(asset: string): Promise<WindowsResponse> {
  const r = await fetch(`/api/windows?asset=${asset}`, { cache: "no-store" });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.message ?? "Could not load windows.");
  }
  return r.json();
}

export function WindowFeed({ onPlaced }: { onPlaced: () => void }) {
  const [asset, setAsset] = useState<(typeof ASSETS)[number]>("BTC");

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["windows", asset],
    queryFn: () => fetchWindows(asset),
    refetchInterval: 10_000,
  });

  // Countdowns run off the SERVER's chain-corrected clock, never the local one.
  const now = useServerClock(data?.serverNowSec);
  useTick(Boolean(data));

  const chosen: WindowDto | undefined = useMemo(() => {
    if (!data) return undefined;
    const tradable = data.windows.filter((w) => w.isTradable);
    // Prefer the demo-friendly series, but never show nothing just because that
    // series happens to be mid-roll.
    const preferred = tradable.filter((w) => w.intervalSec === PREFERRED_INTERVAL);
    const pool = preferred.length > 0 ? preferred : tradable;
    return [...pool].sort((a, b) => a.closesAtSec - b.closesAtSec)[0];
  }, [data]);

  const secondsLeft = chosen ? chosen.closesAtSec - now() / 1000 : 0;
  const handlePlaced = useCallback(() => { onPlaced(); void refetch(); }, [onPlaced, refetch]);

  return (
    <section aria-label="Place a call">
      <div className="mb-3 flex items-center gap-1" role="group" aria-label="Asset">
        {ASSETS.map((a) => (
          <button
            key={a}
            onClick={() => setAsset(a)}
            aria-pressed={asset === a}
            className={`rounded-sm px-3 py-1.5 font-[family-name:var(--font-mono)] text-xs uppercase tracking-wider transition-colors ${
              asset === a ? "bg-accent text-accent-ink" : "text-ink-soft hover:text-ink"
            }`}
          >
            {a}
          </button>
        ))}
        <span className="ml-auto"><LiveDot /></span>
      </div>

      {isPending ? (
        <Card className="p-4">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="mt-3 h-9 w-24" />
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </div>
        </Card>
      ) : isError ? (
        <ErrorNote
          title="Could not load the live windows."
          detail={error instanceof Error ? error.message : undefined}
          action="Your funds are unaffected. This is a read problem only."
          onRetry={() => void refetch()}
        />
      ) : !chosen ? (
        <Card>
          <Empty
            title={`No open ${asset} window right now`}
            hint="Windows open on a schedule and the next one is usually seconds away."
          />
        </Card>
      ) : (
        <div className="space-y-3">
          <Panel
            label={`${chosen.asset} · ${seriesLabel(chosen.intervalSec)} WINDOW`}
            aside={<span className="label">{chosen.isTradable ? "OPEN" : "LOCKED"}</span>}
            bodyClass="p-4 grid-bg"
          >
            <div className="flex items-end justify-between gap-4">
              <div>
                <span className="label">TIME TO CLOSE</span>
                <p className="tabular mt-1 text-4xl font-bold leading-none text-accent">
                  {countdown(secondsLeft)}
                </p>
              </div>
              <div className="text-right">
                <span className="label">OPENING PRICE</span>
                <p className="tabular mt-1 text-sm text-ink-soft">
                  {chosen.strike === "0" ? "SETTING" : chosen.strike}
                </p>
              </div>
            </div>
          </Panel>

          <CallPanel window={chosen} secondsLeft={secondsLeft} onPlaced={handlePlaced} />
        </div>
      )}
    </section>
  );
}
