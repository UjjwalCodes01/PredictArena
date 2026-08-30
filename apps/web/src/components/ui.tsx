"use client";

/**
 * The small shared pieces. Deliberately few and plain.
 *
 * No emoji anywhere in the interface: they render inconsistently across
 * platforms, read badly to screen readers, and make a financial screen look
 * unserious. Meaning is carried by words.
 */
import type { ReactNode, ButtonHTMLAttributes } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-border bg-surface ${className}`}>{children}</div>
  );
}

export function Button({
  variant = "primary",
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" }) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium " +
    "transition-colors disabled:cursor-not-allowed disabled:opacity-45";
  const styles = {
    primary: "bg-accent text-accent-ink hover:opacity-90",
    secondary: "border border-border-strong bg-surface text-ink hover:border-ink-faint",
    ghost: "text-ink-soft hover:text-ink",
  } as const;
  return (
    <button className={`${base} ${styles[variant]} ${className}`} {...rest}>
      {children}
    </button>
  );
}

/** A labelled figure. The unit is separated so numbers stay scannable. */
export function Stat({ label, value, unit }: { label: string; value: ReactNode; unit?: string }) {
  return (
    <div>
      <div className="text-xs text-ink-faint">{label}</div>
      <div className="tabular mt-0.5 text-lg font-semibold text-ink">
        {value}
        {unit ? <span className="ml-1 text-sm font-normal text-ink-soft">{unit}</span> : null}
      </div>
    </div>
  );
}

/**
 * Loading placeholder.
 *
 * A shape the size of the content that is coming, so the layout does not jump
 * when it arrives. CLAUDE.md requires a loading state on every async view.
 */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-border ${className}`} aria-hidden="true" />;
}

/**
 * Empty state.
 *
 * Required to look intentional rather than broken -- a cold-start leaderboard
 * is in the demo, and "nothing here yet" must read as a fact, not a failure.
 */
export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {hint ? <p className="max-w-sm text-sm text-ink-soft">{hint}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/**
 * Error state.
 *
 * Always shows what to DO. A bare "something went wrong" is a bug
 * (CLAUDE.md, error handling).
 */
export function ErrorNote({
  title,
  detail,
  action,
  onRetry,
}: {
  title: string;
  detail?: string;
  action?: string;
  onRetry?: () => void;
}) {
  return (
    <div role="alert" className="rounded-lg border border-warn/40 bg-warn-soft px-4 py-3">
      <p className="text-sm font-medium text-ink">{title}</p>
      {detail ? <p className="mt-1 text-sm text-ink-soft">{detail}</p> : null}
      {action ? <p className="mt-1 text-sm text-ink-soft">{action}</p> : null}
      {onRetry ? (
        <button onClick={onRetry} className="mt-2 text-sm font-medium text-accent underline underline-offset-2">
          Try again
        </button>
      ) : null}
    </div>
  );
}

/** Outcome pill. Colour is reinforced by the word, never replaced by it. */
export function StatusPill({ status }: { status: "PENDING" | "WON" | "LOST" | "VOID" | "FAILED" }) {
  const map = {
    PENDING: { text: "Pending", cls: "border-border-strong text-ink-soft" },
    WON: { text: "Won", cls: "border-up/40 bg-up-soft text-up" },
    LOST: { text: "Lost", cls: "border-down/40 bg-down-soft text-down" },
    VOID: { text: "Void", cls: "border-border-strong bg-bg text-ink-soft" },
    FAILED: { text: "Failed", cls: "border-warn/40 bg-warn-soft text-warn" },
  } as const;
  const s = map[status];
  return (
    <span className={`inline-flex rounded-md border px-2 py-0.5 text-xs font-medium ${s.cls}`}>
      {s.text}
    </span>
  );
}
