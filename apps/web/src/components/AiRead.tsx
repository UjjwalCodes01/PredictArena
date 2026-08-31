"use client";

/**
 * What the AI made of this window, shown beside your own decision.
 *
 * Deliberately understated: it is a second opinion on the same board, not a
 * tip. It renders nothing at all when the forecaster has not looked at this
 * window — which is most of the time — because an empty "no signal" box beside
 * a live countdown is noise competing with the only control that has a
 * deadline attached.
 *
 * It never blocks or gates the call flow. If the fetch fails, nothing appears.
 */
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

interface WindowForecast {
  probabilityUpBps: number;
  confidence: "LOW" | "MEDIUM" | "HIGH";
  rationale: string;
  action: "PLACE" | "PASS";
  passReason: string | null;
  side: "UP" | "DOWN" | null;
  edgeBps: number | null;
}

/** Basis points as a percentage. Integers only — this sits beside a price. */
function bps(value: number): string {
  const whole = Math.trunc(value / 100);
  const frac = Math.abs(Math.round(value % 100));
  return `${whole}.${String(frac).padStart(2, "0")}%`;
}

export function AiRead({ windowId }: { windowId: string }) {
  const { data } = useQuery({
    queryKey: ["ai-window", windowId],
    queryFn: async (): Promise<{ forecast: WindowForecast | null }> => {
      const r = await fetch(`/api/ai/window?id=${windowId}`, { cache: "no-store" });
      if (!r.ok) return { forecast: null };
      return r.json();
    },
    refetchInterval: 30_000,
    retry: false,
  });

  const f = data?.forecast;
  if (!f) return null;

  const traded = f.action === "PLACE";

  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="label">AI READ</span>
        <span className="tabular text-xs text-ink-soft">{bps(f.probabilityUpBps)} Up</span>
        {traded && f.side ? (
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
        <Link href="/ai" className="label ml-auto text-ink-faint hover:text-ink">
          [ RECORD ]
        </Link>
      </div>
      <p className="mt-1.5 text-xs leading-snug text-ink-soft">{f.rationale}</p>
      {/* Never phrased as advice. It is another player's position, and the page
          says so plainly rather than implying you should follow it. */}
      <p className="mt-1 text-xs text-ink-faint">
        Another player&apos;s call, not a recommendation. Its record is on the same board as yours.
      </p>
    </div>
  );
}
