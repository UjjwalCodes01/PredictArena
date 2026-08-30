"use client";

/**
 * Charts, hand-rolled in SVG.
 *
 * No charting library: these are thin single-series traces on a dark panel, and
 * a library would ship far more weight than the marks need while fighting the
 * instrument aesthetic. Drawn directly, they stay 2px strokes on a recessive
 * grid, exactly as specified.
 *
 * Every line chart carries a crosshair and a tooltip by default -- an SVG chart
 * in a browser IS interactive, and a reader should be able to ask "what was it
 * at that moment" without squinting at an axis.
 */
import { useMemo, useRef, useState } from "react";

export interface Point {
  x: number;
  y: number;
}

function path(points: Point[], w: number, h: number, pad: number, min: number, max: number): string {
  if (points.length === 0) return "";
  const span = max - min || 1;
  const xs = points.length > 1 ? (w - pad * 2) / (points.length - 1) : 0;
  return points
    .map((p, i) => {
      const x = pad + i * xs;
      const y = pad + (h - pad * 2) * (1 - (p.y - min) / span);
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

/**
 * A single-series trace.
 *
 * One series, so no legend box -- the panel label names it, which is the rule
 * for a lone series.
 */
export function LineChart({
  points,
  height = 120,
  color = "var(--color-accent)",
  fill = true,
  format,
  unit,
}: {
  points: Point[];
  height?: number;
  color?: string;
  fill?: boolean;
  format?: (y: number) => string;
  unit?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const W = 600;
  const PAD = 6;

  const { min, max, d, area } = useMemo(() => {
    if (points.length === 0) return { min: 0, max: 1, d: "", area: "" };
    const ys = points.map((p) => p.y);
    let lo = Math.min(...ys);
    let hi = Math.max(...ys);
    // A flat series would divide by zero and draw on the floor; give it room.
    if (hi === lo) { hi = lo + Math.abs(lo || 1) * 0.01; lo -= Math.abs(lo || 1) * 0.01; }
    const pad = (hi - lo) * 0.12;
    lo -= pad; hi += pad;
    const line = path(points, W, height, PAD, lo, hi);
    return {
      min: lo, max: hi, d: line,
      area: line ? `${line} L${W - PAD},${height - PAD} L${PAD},${height - PAD} Z` : "",
    };
  }, [points, height]);

  if (points.length === 0) {
    return (
      <div style={{ height }} className="flex items-center justify-center">
        <span className="label">NO SIGNAL</span>
      </div>
    );
  }

  const idx = hover === null ? null : Math.max(0, Math.min(points.length - 1, hover));
  const hx = idx === null ? 0 : PAD + idx * ((W - PAD * 2) / Math.max(1, points.length - 1));
  const hy =
    idx === null ? 0 : PAD + (height - PAD * 2) * (1 - (points[idx]!.y - min) / (max - min || 1));
  const gid = `g-${color.replace(/[^a-z]/gi, "")}`;

  return (
    <div className="relative">
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${height}`}
        preserveAspectRatio="none"
        className="w-full touch-none"
        style={{ height }}
        role="img"
        aria-label={`Trace of ${points.length} readings`}
        onMouseMove={(e) => {
          const r = ref.current?.getBoundingClientRect();
          if (!r) return;
          const frac = (e.clientX - r.left) / r.width;
          setHover(Math.round(frac * (points.length - 1)));
        }}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Recessive grid: present enough to read a level against, never
            competing with the trace. */}
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={PAD} x2={W - PAD}
            y1={PAD + (height - PAD * 2) * f} y2={PAD + (height - PAD * 2) * f}
            stroke="currentColor" strokeWidth="1" className="text-border" strokeDasharray="2 4"
          />
        ))}

        {fill && area ? <path d={area} fill={`url(#${gid})`} /> : null}
        <path d={d} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke"
              strokeLinejoin="round" strokeLinecap="round" />

        {idx !== null ? (
          <>
            <line x1={hx} x2={hx} y1={PAD} y2={height - PAD} stroke={color} strokeWidth="1"
                  strokeOpacity="0.5" vectorEffect="non-scaling-stroke" />
            {/* A surface ring keeps the marker readable wherever it lands. */}
            <circle cx={hx} cy={hy} r="4" fill={color} stroke="var(--color-surface)" strokeWidth="2"
                    vectorEffect="non-scaling-stroke" />
          </>
        ) : null}
      </svg>

      {idx !== null ? (
        <div
          className="pointer-events-none absolute top-1 rounded-sm border border-border-strong bg-bg/95 px-2 py-1"
          style={{ left: `calc(${(idx / Math.max(1, points.length - 1)) * 100}% - 2rem)` }}
        >
          <span className="tabular text-xs text-ink">
            {format ? format(points[idx]!.y) : points[idx]!.y.toFixed(2)}
            {unit ? <span className="ml-1 text-ink-faint">{unit}</span> : null}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Order-book depth.
 *
 * Two groups, so identity cannot rest on colour: each side is direct-labelled
 * BIDS and ASKS, and the two hues were validated for colourblind separation.
 */
export function DepthChart({
  bids, asks, height = 110, decimals = 6,
}: {
  bids: Array<{ price: bigint; quantity: bigint }>;
  asks: Array<{ price: bigint; quantity: bigint }>;
  height?: number;
  decimals?: number;
}) {
  const unit = 10 ** decimals;
  const rows = [
    ...bids.slice(0, 6).map((l) => ({ ...l, side: "BID" as const })),
    ...asks.slice(0, 6).map((l) => ({ ...l, side: "ASK" as const })),
  ];
  if (rows.length === 0) {
    return (
      <div style={{ height }} className="flex items-center justify-center">
        <span className="label">BOOK EMPTY</span>
      </div>
    );
  }
  const maxQty = rows.reduce((m, r) => (r.quantity > m ? r.quantity : m), 1n);

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-4">
        <span className="label flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-[1px] bg-up" /> BIDS
        </span>
        <span className="label flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-[1px] bg-down" /> ASKS
        </span>
      </div>
      <ul className="space-y-0.5">
        {rows.map((r, i) => {
          const pct = Number((r.quantity * 100n) / maxQty);
          const isBid = r.side === "BID";
          return (
            <li key={`${r.side}-${i}`} className="relative flex items-center gap-2 py-0.5">
              <span className="label w-8 shrink-0">{r.side}</span>
              <div className="relative h-4 flex-1 overflow-hidden rounded-[2px] bg-surface-2">
                <div
                  className={`h-full rounded-[2px] ${isBid ? "bg-up/45" : "bg-down/45"}`}
                  style={{ width: `${Math.max(2, pct)}%` }}
                />
              </div>
              <span className="tabular w-14 shrink-0 text-right text-xs text-ink-soft">
                {(Number(r.price) / unit).toFixed(3)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
