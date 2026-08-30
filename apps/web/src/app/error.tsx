"use client";

/**
 * Route-level error boundary. Required by CLAUDE.md's UI standards: no screen
 * may white-screen, and every failure has to say what to do next.
 */
export default function ErrorBoundary({
  error, reset,
}: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert" className="py-16 text-center">
      <h1 className="text-lg font-semibold text-ink">Something did not load</h1>
      <p className="mx-auto mt-1 max-w-md text-sm text-ink-soft">
        {error.message || "The page failed to load."} Your funds and positions are on-chain and
        unaffected.
      </p>
      <button
        onClick={reset}
        className="mt-4 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink"
      >
        Try again
      </button>
    </div>
  );
}
