"use client";

/**
 * The AI forecaster's dossier.
 *
 * The whole point of this page is that it can embarrass the forecaster. Its
 * rank, Brier score and edge come from `getStandings` — the same pure engine
 * that ranks every human — and its edge is shown beside the median human's. If
 * the machine is worse, the page says the machine is worse. A benchmark that
 * cannot report a loss is marketing, not a benchmark.
 *
 * What it adds beyond the leaderboard is the reasoning: what it estimated, what
 * the market was charging at that moment, and whether it acted. Passing is
 * shown as prominently as trading, because a forecaster with no threshold is a
 * coin flip with a rationale attached.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Image from "next/image";
import Link from "next/link";
import type { AiResponse, ForecastDto } from "@/lib/types";
import { Card, Empty, ErrorNote, Panel, Skeleton, Stat } from "@/components/ui";
import { shortAddress, timeAgo } from "@/lib/format";

async function fetchAi(): Promise<AiResponse> {
  const r = await fetch("/api/ai", { cache: "no-store" });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.message ?? "Could not load the forecaster.");
  }
  return r.json();
}

/** Basis points as a percentage, without a float ever touching a price. */
function bps(value: number): string {
  const whole = Math.trunc(value / 100);
  const frac = Math.abs(Math.round(value % 100));
  return `${whole}.${String(frac).padStart(2, "0")}%`;
}

/** Signed basis points, for an edge. */
function signedBps(value: number): string {
  return `${value > 0 ? "+" : value < 0 ? "-" : ""}${bps(Math.abs(value))}`;
}

const PASS_COPY: Record<string, string> = {
  NO_EDGE: "Market already agreed",
  NO_BOOK: "Nothing to trade against",
  PRICE_EXTREME: "Price too close to the tails",
  BUDGET_SPENT: "Budget spent this cycle",
  WINDOW_CLOSING: "Window locked first",
};

function ForecastRow({ f }: { f: ForecastDto }) {
  const marketBps = f.side === "DOWN" ? f.askDownBps : f.askUpBps;

  return (
    <li className="px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="tabular text-sm font-medium text-ink">{f.asset}</span>

        {f.action === "PLACE" ? (
          <span
            className={`rounded-sm px-1.5 py-0.5 text-xs font-medium ${
              f.side === "UP" ? "bg-up-soft text-up" : "bg-down-soft text-down"
            }`}
          >
            Called {f.side === "UP" ? "Up" : "Down"}
          </span>
        ) : (
          <span className="rounded-sm bg-surface-2 px-1.5 py-0.5 text-xs font-medium text-ink-soft">
            Passed
          </span>
        )}

        {/* The claim itself: what it thought, against what the market charged. */}
        <span className="tabular text-xs text-ink-soft">
          Estimated {bps(f.probabilityUpBps)} Up
          {marketBps !== null && f.side !== null
            ? ` · market asked ${bps(marketBps)} for ${f.side === "UP" ? "Up" : "Down"}`
            : f.askUpBps !== null
              ? ` · market asked ${bps(f.askUpBps)} for Up`
              : ""}
        </span>

        {f.action === "PLACE" && f.edgeBps !== null ? (
          <span className={`tabular text-xs ${f.edgeBps > 0 ? "text-up" : "text-down"}`}>
            {signedBps(f.edgeBps)} edge
          </span>
        ) : null}

        {f.outcome && f.outcome !== "PENDING" ? (
          <span
            className={`tabular text-xs font-medium ${
              f.outcome === "WON" ? "text-up" : f.outcome === "LOST" ? "text-down" : "text-ink-soft"
            }`}
          >
            {f.outcome === "WON" ? "Won" : f.outcome === "LOST" ? "Lost" : "Void"}
          </span>
        ) : f.outcome === "PENDING" ? (
          <span className="tabular text-xs text-ink-faint">Open</span>
        ) : null}

        <span className="tabular ml-auto shrink-0 text-xs text-ink-faint">
          {timeAgo(new Date(f.createdAtSec * 1000))}
        </span>
      </div>

      <p className="mt-1.5 text-sm leading-snug text-ink-soft">{f.rationale}</p>

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <span className="label">{f.confidence} confidence</span>
        {f.action === "PASS" && f.passReason ? (
          <span className="label text-ink-faint">· {PASS_COPY[f.passReason] ?? f.passReason}</span>
        ) : null}
        {f.keyFactors.slice(0, 3).map((k) => (
          <span key={k} className="rounded-sm bg-surface-2 px-1.5 py-0.5 text-xs text-ink-faint">
            {k}
          </span>
        ))}
      </div>
    </li>
  );
}

export default function AiPage() {
  const [filter, setFilter] = useState<"all" | "traded">("all");

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["ai"],
    queryFn: fetchAi,
    refetchInterval: 25_000,
  });

  const s = data?.standing ?? null;
  const rows = (data?.forecasts ?? []).filter((f) => filter === "all" || f.action === "PLACE");

  const passRate =
    data && data.summary.total > 0
      ? Math.round((data.summary.passed / data.summary.total) * 100)
      : null;

  return (
    <>
      <div className="mb-4 overflow-hidden rounded-xl border border-border">
        <div className="relative h-28 w-full sm:h-32 lg:h-40">
          <Image
            src="/img/data-abstract.jpg"
            alt=""
            fill
            priority
            sizes="(max-width: 1600px) 100vw, 1600px"
            className="object-cover"
          />
          <div className="absolute inset-0 bg-black/60" />
          <div className="absolute inset-0 flex flex-col justify-end p-4">
            <h1 className="text-xl font-semibold tracking-tight text-white">The AI forecaster</h1>
            <p className="mt-0.5 max-w-2xl text-sm text-white/80">
              It does not advise you. It plays — its own wallet, real calls, ranked on the same
              board by the same Brier score and edge as everyone else.
            </p>
          </div>
        </div>
      </div>

      {isPending ? (
        <Card className="p-4">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i}>
                <Skeleton className="h-3 w-16" />
                <Skeleton className="mt-2 h-6 w-12" />
              </div>
            ))}
          </div>
        </Card>
      ) : isError ? (
        <ErrorNote
          title="Could not load the forecaster."
          detail={error instanceof Error ? error.message : undefined}
          onRetry={() => void refetch()}
        />
      ) : !data?.configured ? (
        <Card>
          <Empty
            title="The forecaster is offline"
            hint={
              data?.provider
                ? `${data.provider} is configured, but the forecaster has no wallet — set AI_PRIVATE_KEY. Everything else on the site works exactly as it does with it running.`
                : "No model provider is configured on this deployment — neither Vertex AI nor a Gemini API key — so nothing is forecasting. Everything else on the site works exactly as it does with it running."
            }
          />
        </Card>
      ) : (
        <>
          {/* The record, from the same engine that ranks humans. */}
          <Panel
            label="RECORD"
            aside={
              <div className="flex items-center gap-3">
                {data.provider ? (
                  <span className="label text-ink-faint" title={data.model ?? undefined}>
                    {data.provider}
                  </span>
                ) : null}
                {data.wallet ? (
                  <Link
                    href={`/p/${data.wallet}`}
                    className="tabular text-xs text-ink-faint hover:text-ink"
                  >
                    {shortAddress(data.wallet)}
                  </Link>
                ) : null}
              </div>
            }
          >
            {s === null ? (
              <p className="text-sm text-ink-soft">
                No settled calls yet this week. The forecaster appears on the leaderboard the moment
                one of its calls resolves — it is not seeded, and it gets no head start.
              </p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <Stat label="RANK" value={`#${s.rank}`} />
                  <Stat label="RECORD" value={`${s.wins}-${s.losses}`} />
                  <Stat
                    label="BRIER"
                    value={s.brier === null ? "—" : s.brier.toFixed(3)}
                    tone={s.brier === null ? "default" : s.brier < data.coinFlipBrier ? "up" : "down"}
                  />
                  <Stat
                    label="EDGE"
                    value={s.edge === null ? "—" : `${s.edge > 0 ? "+" : ""}${s.edge}`}
                    tone={s.edge === null ? "default" : s.edge > 0 ? "up" : "down"}
                  />
                </div>

                {/* The comparison that makes the number mean something. */}
                <div className="mt-4 border-t border-border pt-3 text-sm text-ink-soft">
                  {s.brier === null ? (
                    <p>
                      Brier and edge appear after 5 settled calls with a derivable price. Below that
                      the figures are noise, so the board shows a dash rather than a number nobody
                      should trust.
                    </p>
                  ) : (
                    <p>
                      Scoring{" "}
                      <strong className="tabular text-ink">{s.brier.toFixed(3)}</strong> against{" "}
                      <strong className="tabular text-ink">{data.coinFlipBrier.toFixed(3)}</strong> for
                      always saying 50%
                      {data.fieldBrier !== null ? (
                        <>
                          , and{" "}
                          <strong className="tabular text-ink">{data.fieldBrier.toFixed(3)}</strong>{" "}
                          for the median human with a ranked score
                          {data.rankedPlayers > 0 ? ` (${data.rankedPlayers} players)` : ""}
                        </>
                      ) : null}
                      .{" "}
                      {s.brier < data.coinFlipBrier
                        ? "Lower is better, so it is beating a coin flip."
                        : "Lower is better, so it is not yet beating a coin flip."}
                    </p>
                  )}
                </div>
              </>
            )}
          </Panel>

          {/* Discipline. The pass rate is the headline a forecaster earns. */}
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <Panel label="DISCIPLINE" className="md:col-span-1">
              <div className="grid grid-cols-2 gap-4">
                <Stat label="WINDOWS SEEN" value={data.summary.total} />
                <Stat label="TRADED" value={data.summary.placed} />
              </div>
              <p className="mt-3 text-sm leading-snug text-ink-soft">
                {passRate === null
                  ? "It has not looked at a window yet."
                  : `It passed on ${passRate}% of them. A forecaster that bets every window is a coin flip with extra steps — it only acts when its estimate beats the market price by a margin wide enough to survive its own error.`}
              </p>
            </Panel>

            <Panel label="HOW IT DECIDES" className="md:col-span-2">
              <ol className="space-y-2 text-sm leading-snug text-ink-soft">
                <li>
                  <span className="text-ink">1.</span> Reads the live window, the resting order book
                  and how the last twelve windows on that series actually resolved.
                </li>
                <li>
                  <span className="text-ink">2.</span> {data.model ?? "The model"} estimates the
                  probability the window closes Up, and states how much it trusts its own estimate.
                </li>
                <li>
                  <span className="text-ink">3.</span> That estimate is compared to what the book is
                  charging. The gap is the edge — and a shakier estimate has to show a wider one.
                </li>
                <li>
                  <span className="text-ink">4.</span> Only then does it place a real order, from
                  its own wallet, through the same code path as the button you press.
                </li>
              </ol>
            </Panel>
          </div>

          {/* The log. */}
          <div className="mt-3">
            <Panel
              label="FORECAST LOG"
              bodyClass=""
              aside={
                <div className="flex gap-1">
                  {(["all", "traded"] as const).map((k) => (
                    <button
                      key={k}
                      onClick={() => setFilter(k)}
                      aria-pressed={filter === k}
                      className={`label px-1.5 py-0.5 transition-colors ${
                        filter === k ? "text-accent-text" : "text-ink-faint hover:text-ink"
                      }`}
                    >
                      {k === "all" ? "ALL" : "TRADED"}
                    </button>
                  ))}
                </div>
              }
            >
              {rows.length === 0 ? (
                <Empty
                  title={filter === "traded" ? "It has not traded yet" : "Nothing forecast yet"}
                  hint={
                    filter === "traded"
                      ? "Every window so far has been one it declined. Switch to ALL to see why."
                      : "The forecaster runs while people are on the site. Check back in a few minutes."
                  }
                />
              ) : (
                <ul className="divide-y divide-border">
                  {rows.map((f) => (
                    <ForecastRow key={`${f.windowId}-${f.createdAtSec}`} f={f} />
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <p className="mt-4 text-xs leading-relaxed text-ink-faint">
            Every estimate above was recorded <strong className="text-ink">before</strong> its
            window closed, together with the prices the market was showing at that moment, and rows
            are never revised. Whether a call won is read from the chain through the same indexer
            that scores every player — never from anything stored beside the forecast. The
            forecaster holds an ordinary burner wallet on Somnia Shannon testnet and can lose, and
            when it does, this page says so.
          </p>
        </>
      )}
    </>
  );
}
