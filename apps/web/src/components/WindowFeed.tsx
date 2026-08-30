"use client";

/**
 * The windows feed and the live call flow.
 *
 * Deliberately shows ONE window at a time -- the next one to settle for the
 * chosen asset. A grid of every open window is more information than a decision
 * needs, and the whole point of the product is a one-tap call.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
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

  // The window currently on screen. Held in state, not recomputed per refetch.
  //
  // Recomputing it every ten seconds made the display jump between series --
  // observed live going 2:39 -> 12:37 -> 9:20 -> 0:34 as the preferred 5-minute
  // series rolled in and out of the tradable set. To someone mid-decision the
  // market simply changed underneath them, which reads as the page breaking.
  const [pinnedId, setPinnedId] = useState<string | null>(null);

  const { chosen, next } = useMemo((): { chosen?: WindowDto; next?: WindowDto } => {
    if (!data) return {};
    const tradable = data.windows.filter((w) => w.isTradable);

    // Stay on the pinned window while it is still tradable.
    const pinned = pinnedId ? tradable.find((w) => w.marketId === pinnedId) : undefined;

    // Prefer the demo-friendly series, but never show nothing just because that
    // series happens to be mid-roll.
    const preferred = tradable.filter((w) => w.intervalSec === PREFERRED_INTERVAL);
    const pool = preferred.length > 0 ? preferred : tradable;
    const sorted = [...pool].sort((a, b) => a.closesAtSec - b.closesAtSec);
    const current = pinned ?? sorted[0];
    // The next window is the next one to CLOSE LATER -- not simply the second
    // in the list. The venue runs several windows of a series concurrently, so
    // sorted[1] is often a parallel window closing at the same moment, and
    // calling that "next" would tell someone to wait for something already
    // running.
    const following = current
      ? sorted.find((w) => w.closesAtSec > current.closesAtSec)
      : undefined;
    return { chosen: current, next: following };
  }, [data, pinnedId]);

  // Pin whatever is being shown, and release the pin only when that window is
  // no longer tradable — at which point the next refetch picks a fresh one.
  useEffect(() => {
    if (chosen && chosen.marketId !== pinnedId) setPinnedId(chosen.marketId);
  }, [chosen, pinnedId]);

  useEffect(() => {
    if (!data || !pinnedId) return;
    const stillOpen = data.windows.some((w) => w.marketId === pinnedId && w.isTradable);
    if (!stillOpen) setPinnedId(null);
  }, [data, pinnedId]);

  const secondsLeft = chosen ? chosen.closesAtSec - now() / 1000 : 0;
  const handlePlaced = useCallback(() => { onPlaced(); void refetch(); }, [onPlaced, refetch]);

  // Shown after a window locks mid-decision, so the swap underneath the user is
  // explained rather than just happening.
  const [rolled, setRolled] = useState(false);
  const handleWindowClosed = useCallback(() => {
    setRolled(true);
    void refetch();
    // Long enough to read, short enough not to linger over the next decision.
    setTimeout(() => setRolled(false), 8000);
  }, [refetch]);

  return (
    <section aria-label="Place a call">
      <div className="mb-3 flex items-center gap-1" role="group" aria-label="Asset">
        {ASSETS.map((a) => (
          <button
            key={a}
            onClick={() => { setAsset(a); setPinnedId(null); }}
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
          {rolled ? (
            <div role="status" className="rounded-md border border-warn/40 bg-warn-soft/60 px-3 py-2">
              <p className="text-sm text-ink">
                That window closed while you were deciding. You are on the next one.
              </p>
            </div>
          ) : null}
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

          <CallPanel
            window={chosen}
            secondsLeft={secondsLeft}
            onPlaced={handlePlaced}
            onWindowClosed={handleWindowClosed}
          />

          {/*
            What comes next. Two honest cases, and no invented times:

            - A later window of this series is already open -- show when it
              settles, which is a fact the API gave us.
            - None is open yet, because the venue runs this series' windows in
              parallel and starts the next batch on close. Say that, rather
              than deriving an "opens in" from close-minus-interval, which
              would be a guess about scheduling presented as a countdown.
          */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2">
            <span className="label">NEXT WINDOW</span>
            <span className="tabular text-xs text-ink-soft">
              {next
                ? `${seriesLabel(next.intervalSec)} · settles in ${countdown(next.closesAtSec - now() / 1000)}`
                : `a new ${seriesLabel(chosen.intervalSec)} window opens when this one closes`}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
