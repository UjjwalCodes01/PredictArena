"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A clock aligned to the SERVER's chain-corrected time.
 *
 * AGENTS.md forbids trusting the browser clock for cutoffs: a machine two
 * minutes fast would show a window as closed while it is still trading, or
 * still open after it locked. The server sends its chain time with every
 * windows response; we hold the offset and tick locally from there.
 */
export function useServerClock(serverNowSec: number | undefined): () => number {
  const offsetMs = useRef(0);

  useEffect(() => {
    if (serverNowSec === undefined) return;
    offsetMs.current = serverNowSec * 1000 - Date.now();
  }, [serverNowSec]);

  return () => Date.now() + offsetMs.current;
}

/**
 * Re-renders once a second so countdowns advance.
 *
 * One timer for the whole page rather than one per card: a feed of ten windows
 * should not run ten intervals.
 */
export function useTick(active = true): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
  return tick;
}
