"use client";

/**
 * Pokes the ingestion tick while someone is looking at the site.
 *
 * The indexer is a daemon and there is nowhere free and reliable to run one,
 * so the site keeps its own projection fresh off the back of ordinary traffic.
 * The endpoint does nothing unless the data has actually gone stale.
 *
 * Deliberately quiet: it never blocks a render, never shows an error, and
 * never retries aggressively. If it fails, the page is exactly as useful as it
 * was before — just displaying older results, which the UI already says.
 */
import { useEffect } from "react";

/** Poke on mount, then occasionally. Long enough not to be chatty. */
const INTERVAL_MS = 90_000;

export function KeepFresh() {
  useEffect(() => {
    let cancelled = false;

    const poke = (): void => {
      // A backgrounded tab should not keep waking a serverless function.
      if (document.visibilityState !== "visible") return;
      void fetch("/api/tick", { cache: "no-store" }).catch(() => {
        /* best effort; the UI already reports staleness on its own */
      });
    };

    poke();
    const id = setInterval(() => { if (!cancelled) poke(); }, INTERVAL_MS);

    // Coming back to the tab is exactly when stale data is most visible.
    const onVisible = (): void => { if (document.visibilityState === "visible") poke(); };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return null;
}
