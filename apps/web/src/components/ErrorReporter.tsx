"use client";

/**
 * Sends browser errors somewhere a human will see them.
 *
 * Without this, a crash in the client half of the app lands in the user's
 * console and nowhere else — and that is the half most likely to break in ways
 * we cannot reproduce: one wallet extension, one browser, one flaky network.
 *
 * Deliberately minimal and deliberately silent. Reporting must never itself
 * throw, never block a render, and never turn one error into a loop of
 * reports about failing to report.
 */
import { useEffect } from "react";

/** Same error twice in a session is noise; the first one is the signal. */
const seen = new Set<string>();
const MAX_PER_SESSION = 8;

export function report(message: string, stack?: string, digest?: string): void {
  if (typeof window === "undefined") return;

  const key = `${message}::${digest ?? ""}`.slice(0, 200);
  if (seen.has(key) || seen.size >= MAX_PER_SESSION) return;
  seen.add(key);

  // keepalive so a report survives the page being navigated away from, which
  // is exactly when a fatal error tends to happen.
  void fetch("/api/client-error", {
    method: "POST",
    headers: { "content-type": "application/json" },
    keepalive: true,
    body: JSON.stringify({
      message,
      stack,
      digest,
      url: window.location.pathname + window.location.search,
    }),
  }).catch(() => {
    /* reporting must never surface an error of its own */
  });
}

/** Catches what React's error boundaries do not: raw window errors. */
export function ErrorReporter() {
  useEffect(() => {
    const onError = (e: ErrorEvent): void => {
      report(e.message, e.error instanceof Error ? e.error.stack : undefined);
    };
    const onRejection = (e: PromiseRejectionEvent): void => {
      const r = e.reason;
      report(
        r instanceof Error ? r.message : String(r).slice(0, 300),
        r instanceof Error ? r.stack : undefined,
      );
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}
