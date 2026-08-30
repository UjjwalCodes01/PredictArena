"use client";

/**
 * The terminal: one window, fully instrumented.
 *
 * Laid out as a telemetry readout because that is what the data is -- a signal
 * (the underlying price), a derived channel (what the market thinks), and the
 * book behind both. Panels are labelled like instrument channels so a dense
 * grid stays scannable without headings competing with the numbers.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { countdown, seriesLabel, percent } from "@/lib/format";
import { useServerClock, useTick } from "@/hooks/useServerClock";
import { LineChart, DepthChart, type Point } from "@/components/Chart";
import { Panel, Stat, Skeleton, ErrorNote, BracketButton, LiveDot, Button } from "@/components/ui";

interface Telemetry {
  serverNowSec: number;
  asset: string;
  live: { price: number | null } | null;
  priceSeries: Array<{ t: number; v: number }>;
  window: {
    marketId: string; asset: string; intervalSec: number | null; strike: string;
    opensAtSec: number; closesAtSec: number; secondsLeft: number; status: number;
    isTradable: boolean; question: string; upPrice: string | null; downPrice: string | null;
  } | null;
  windows: Array<{ marketId: string; intervalSec: number | null; secondsLeft: number; isTradable: boolean }>;
  book: {
    yesBids: Array<{ price: string; quantity: string }>;
    yesAsks: Array<{ price: string; quantity: string }>;
  };
  trades: Array<{ t: number; price: string; quantity: string }>;
}

const ASSETS = ["BTC", "ETH"] as const;

export default function TerminalPage() {
  const [asset, setAsset] = useState<(typeof ASSETS)[number]>("BTC");
  const [marketId, setMarketId] = useState<string | null>(null);

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["telemetry", asset, marketId],
    queryFn: async (): Promise<Telemetry> => {
      const q = new URLSearchParams({ asset });
      if (marketId) q.set("marketId", marketId);
      const r = await fetch(`/api/telemetry?${q}`, { cache: "no-store" });
      if (!r.ok) {
        const b = await r.json().catch(() => ({}));
        throw new Error(b.message ?? "Telemetry unavailable.");
      }
      return r.json();
    },
    refetchInterval: 5_000,
  });

  const now = useServerClock(data?.serverNowSec);
  useTick(Boolean(data));

  const w = data?.window ?? null;
  const left = w ? w.closesAtSec - now() / 1000 : 0;

  const priceTrace: Point[] = useMemo(
    () => (data?.priceSeries ?? []).map((p, i) => ({ x: i, y: p.v })),
    [data],
  );

  // What the market believed, over the life of the window: each fill is a
  // reading of the crowd's estimate.
  const beliefTrace: Point[] = useMemo(
    () => (data?.trades ?? []).map((t, i) => ({ x: i, y: Number(t.price) / 1e6 })),
    [data],
  );

  const idx = data?.windows.findIndex((x) => x.marketId === w?.marketId) ?? -1;
  const step = (delta: number) => {
    if (!data || idx < 0) return;
    const next = data.windows[idx + delta];
    if (next) setMarketId(next.marketId);
  };

  return (
    <>
      {/* Session bar, in the shape of an instrument header */}
      <div className="mb-3 rounded-md border border-border bg-surface grid-bg">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border p-3">
          <div>
            <h1 className="text-lg font-bold uppercase tracking-tight text-ink">Terminal</h1>
            <p className="label mt-0.5">WINDOW TELEMETRY</p>
          </div>
          <div className="flex items-center gap-3">
            <LiveDot />
            <span className="label">SOMNIA · SHANNON</span>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3 p-3">
          <label className="block">
            <span className="label block">ASSET</span>
            <select
              value={asset}
              onChange={(e) => { setAsset(e.target.value as typeof asset); setMarketId(null); }}
              className="tabular mt-1 rounded-sm border border-border-strong bg-surface-2 px-2 py-1.5 text-xs text-ink"
            >
              {ASSETS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>

          <label className="block min-w-40 flex-1">
            <span className="label block">WINDOW</span>
            <select
              value={w?.marketId ?? ""}
              onChange={(e) => setMarketId(e.target.value)}
              className="tabular mt-1 w-full rounded-sm border border-border-strong bg-surface-2 px-2 py-1.5 text-xs text-ink"
            >
              {(data?.windows ?? []).map((x) => (
                <option key={x.marketId} value={x.marketId}>
                  {seriesLabel(x.intervalSec)} · {x.secondsLeft > 0 ? `${Math.round(x.secondsLeft)}s left` : "closed"}
                </option>
              ))}
            </select>
          </label>

          <div className="flex items-center gap-1 pb-1">
            <BracketButton onClick={() => step(-1)} disabled={idx <= 0}>PREV</BracketButton>
            <BracketButton onClick={() => step(1)} disabled={idx < 0 || idx >= (data?.windows.length ?? 0) - 1}>NEXT</BracketButton>
          </div>

          <Link href="/" className="pb-1">
            <Button>PLACE CALL</Button>
          </Link>
        </div>
      </div>

      {isError ? (
        <ErrorNote
          title="Telemetry unavailable."
          detail={error instanceof Error ? error.message : undefined}
          action="The chain and your positions are unaffected."
          onRetry={() => void refetch()}
        />
      ) : null}

      {/* Readout row */}
      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Panel label="TIME TO CLOSE" bodyClass="p-3">
          {isPending ? <Skeleton className="h-7 w-20" /> : (
            <span className="tabular text-2xl font-bold leading-none text-accent">
              {left > 0 ? countdown(left) : "CLOSED"}
            </span>
          )}
        </Panel>
        <Panel label={`${asset} SPOT`} bodyClass="p-3">
          {isPending ? <Skeleton className="h-7 w-24" /> : (
            <span className="tabular text-2xl font-bold leading-none text-ink">
              {data?.live?.price ? data.live.price.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"}
            </span>
          )}
        </Panel>
        <Panel label="UP" bodyClass="p-3">
          {isPending ? <Skeleton className="h-7 w-16" /> : (
            <span className="tabular text-2xl font-bold leading-none text-up">
              {w?.upPrice ? percent(BigInt(w.upPrice)) : "—"}
            </span>
          )}
        </Panel>
        <Panel label="DOWN" bodyClass="p-3">
          {isPending ? <Skeleton className="h-7 w-16" /> : (
            <span className="tabular text-2xl font-bold leading-none text-down">
              {w?.downPrice ? percent(BigInt(w.downPrice)) : "—"}
            </span>
          )}
        </Panel>
      </div>

      <div className="space-y-3">
        <Panel
          label={`${asset}/USD · UNDERLYING PRICE`}
          aside={
            <span className="tabular text-xs text-ink-soft">
              {data?.priceSeries.length ?? 0} PTS
            </span>
          }
          bodyClass="p-3"
        >
          {isPending ? <Skeleton className="h-28 w-full" /> : (
            <LineChart
              points={priceTrace}
              height={130}
              color="var(--color-accent)"
              format={(v) => v.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            />
          )}
        </Panel>

        <Panel
          label="MARKET BELIEF · UP PROBABILITY PER TRADE"
          aside={<span className="tabular text-xs text-ink-soft">{data?.trades.length ?? 0} FILLS</span>}
          bodyClass="p-3"
        >
          {isPending ? <Skeleton className="h-24 w-full" /> : (
            <LineChart
              points={beliefTrace}
              height={110}
              color="var(--color-up)"
              format={(v) => `${(v * 100).toFixed(1)}%`}
            />
          )}
        </Panel>

        <div className="grid gap-3 sm:grid-cols-2">
          <Panel label="ORDER BOOK DEPTH" bodyClass="p-3">
            {isPending ? <Skeleton className="h-28 w-full" /> : (
              <DepthChart
                bids={(data?.book.yesBids ?? []).map((l) => ({ price: BigInt(l.price), quantity: BigInt(l.quantity) }))}
                asks={(data?.book.yesAsks ?? []).map((l) => ({ price: BigInt(l.price), quantity: BigInt(l.quantity) }))}
              />
            )}
          </Panel>

          <Panel label="WINDOW PARAMETERS" bodyClass="p-3">
            {isPending ? <Skeleton className="h-28 w-full" /> : w ? (
              <div className="grid grid-cols-2 gap-3">
                <Stat label="SERIES" value={seriesLabel(w.intervalSec)} />
                <Stat label="STATUS" value={w.isTradable ? "TRADING" : "LOCKED"} tone={w.isTradable ? "up" : "down"} />
                <Stat label="STRIKE" value={w.strike === "0" ? "SETTING" : w.strike} />
                <Stat label="OPENED" value={new Date(w.opensAtSec * 1000).toUTCString().slice(17, 25)} />
              </div>
            ) : <span className="label">NO WINDOW</span>}
          </Panel>
        </div>
      </div>

      {w ? (
        <p className="mt-3 text-xs leading-relaxed text-ink-faint">
          {w.question}
        </p>
      ) : null}
    </>
  );
}
