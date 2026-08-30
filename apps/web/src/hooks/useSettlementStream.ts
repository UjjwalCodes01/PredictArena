"use client";

/**
 * Live settlement updates, with polling as the guarantee.
 *
 * AGENTS.md prefers a push channel here, and the difference is visible: a
 * settled call appears the moment the indexer records it rather than up to a
 * poll interval later.
 *
 * The stream is an OPTIMISATION, never the guarantee. Corporate proxies strip
 * `text/event-stream`, serverless platforms cap connection lifetime, and phones
 * suspend background tabs. So the caller keeps a slow poll running regardless;
 * this hook only makes it faster when the channel is available.
 *
 * On a `changed` event it invalidates the positions query rather than carrying
 * its own copy of the data — one code path shapes calls, so the two can never
 * disagree.
 */
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

export type StreamState = "idle" | "connecting" | "live" | "fallback";

export function useSettlementStream(wallet: string | undefined): StreamState {
  const queryClient = useQueryClient();
  const [state, setState] = useState<StreamState>("idle");
  // Reconnects are expected (the server closes before the platform's cap), so
  // an ordinary close must not look like a failure.
  const attempts = useRef(0);

  useEffect(() => {
    if (!wallet) {
      setState("idle");
      return;
    }
    if (typeof window === "undefined" || typeof EventSource === "undefined") {
      setState("fallback");
      return;
    }

    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const connect = (): void => {
      if (cancelled) return;
      setState("connecting");
      source = new EventSource(`/api/stream?wallet=${wallet}`);

      source.addEventListener("ready", () => {
        attempts.current = 0;
        setState("live");
      });

      source.addEventListener("changed", () => {
        // Re-read through the normal endpoint; never trust the stream's own
        // shape of the data.
        void queryClient.invalidateQueries({ queryKey: ["positions"] });
        void queryClient.invalidateQueries({ queryKey: ["standings"] });
        void queryClient.invalidateQueries({ queryKey: ["claimable"] });
      });

      source.onerror = () => {
        source?.close();
        if (cancelled) return;
        attempts.current += 1;
        // Give up after a few tries and say so: a proxy that strips SSE will
        // never succeed, and reconnecting forever burns the user's battery.
        if (attempts.current > 4) {
          setState("fallback");
          return;
        }
        // Backoff, capped — a server that closes on schedule should be
        // reconnected to promptly, a broken one should not be hammered.
        const delay = Math.min(1_000 * 2 ** (attempts.current - 1), 15_000);
        retry = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      source?.close();
    };
  }, [wallet, queryClient]);

  return state;
}
