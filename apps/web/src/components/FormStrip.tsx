"use client";

import type { CallDto } from "@/lib/types";

/**
 * Recent form at a glance.
 *
 * Each square is one settled call, newest first. Letters as well as colour, so
 * it reads without relying on hue -- W, L and V are unambiguous where a row of
 * green and red squares is not.
 */
export function FormStrip({ calls }: { calls: CallDto[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Recent results, newest first">
      {calls.map((c) => {
        const style =
          c.status === "WON" ? "border-up/40 bg-up-soft text-up"
          : c.status === "LOST" ? "border-down/40 bg-down-soft text-down"
          : "border-border-strong bg-bg text-ink-faint";
        const letter = c.status === "WON" ? "W" : c.status === "LOST" ? "L" : "V";
        return (
          <li
            key={c.id}
            title={`${c.asset} ${c.direction === "UP" ? "Up" : "Down"} — ${c.status.toLowerCase()}`}
            className={`flex h-7 w-7 items-center justify-center rounded-md border text-xs font-semibold ${style}`}
          >
            {letter}
          </li>
        );
      })}
    </ul>
  );
}
