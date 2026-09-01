"use client";

/**
 * Instrument-panel primitives.
 *
 * Everything is a titled panel with a small upper-case label, the way a
 * telemetry readout is laid out: the label names the channel, the panel holds
 * the data, and nothing competes for attention with the numbers.
 *
 * No emoji anywhere. Meaning is carried by words and by position.
 */
import Image from "next/image";
import type { ReactNode, ButtonHTMLAttributes } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-md border border-border bg-surface ${className}`}>{children}</div>;
}

/** A panel with a channel label, and optionally a readout in the corner. */
export function Panel({
  label, aside, children, className = "", bodyClass = "p-4",
}: {
  label: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClass?: string;
}) {
  return (
    <section className={`rounded-md border border-border bg-surface ${className}`}>
      <header className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <h2 className="label">{label}</h2>
        {aside ? <div className="flex items-center gap-3">{aside}</div> : null}
      </header>
      <div className={bodyClass}>{children}</div>
    </section>
  );
}

export function Button({
  variant = "primary",
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" }) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-sm px-3.5 py-2 text-xs font-medium " +
    "uppercase tracking-wider transition-colors disabled:cursor-not-allowed disabled:opacity-40 " +
    "font-[family-name:var(--font-mono)]";
  const styles = {
    primary: "bg-accent text-accent-ink hover:brightness-110",
    secondary: "border border-border-strong bg-surface-2 text-ink hover:border-ink-faint",
    ghost: "text-ink-soft hover:text-ink",
  } as const;
  return (
    <button className={`${base} ${styles[variant]} ${className}`} {...rest}>
      {children}
    </button>
  );
}

/** Bracketed control, as used for stepping through records. */
export function BracketButton({
  children, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return (
    <button
      className="label whitespace-nowrap px-1.5 py-1 text-ink-soft transition-colors hover:text-accent disabled:opacity-35"
      {...rest}
    >
      [ {children} ]
    </button>
  );
}

/** A labelled figure. The unit is separated so the number stays scannable. */
export function Stat({
  label, value, unit, tone = "default",
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  tone?: "default" | "accent" | "up" | "down";
}) {
  const toneClass = {
    default: "text-ink",
    accent: "text-accent",
    up: "text-up",
    down: "text-down",
  }[tone];
  return (
    <div>
      <div className="label">{label}</div>
      <div className={`tabular mt-1 text-lg font-semibold leading-none ${toneClass}`}>
        {value}
        {unit ? <span className="ml-1 text-xs font-normal text-ink-faint">{unit}</span> : null}
      </div>
    </div>
  );
}

/**
 * A list that scrolls inside its panel instead of stretching the page.
 *
 * Focusable on purpose: a region that scrolls with the mouse must also scroll
 * with the keyboard, and a plain `overflow` div is unreachable by tab, so arrow
 * keys never reach it (WCAG 2.1.1).
 *
 * `label` names it for a screen reader, which otherwise announces an unlabelled
 * region and gives no clue what is inside.
 */
export function ScrollArea({
  label, maxClass, className = "", children,
}: {
  label: string;
  /** Height cap. Passed in because the right bound differs per surface. */
  maxClass: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`scroll-area ${maxClass} ${className}`}
      tabIndex={0}
      role="region"
      aria-label={label}
    >
      {children}
    </div>
  );
}

/** Loading placeholder shaped like the content that is coming. */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-sm bg-border ${className}`} aria-hidden="true" />;
}

/** Empty state. Must read as a fact, not a fault. */
export function Empty({
  title, hint, action, image,
}: { title: string; hint?: string; action?: ReactNode; image?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      {image ? (
        <Image
          src={image}
          alt=""
          width={88}
          height={88}
          className="mb-2 h-22 w-22 rounded-md object-cover opacity-40 grayscale"
        />
      ) : null}
      <p className="text-sm font-medium text-ink">{title}</p>
      {hint ? <p className="max-w-sm text-sm text-ink-soft">{hint}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/** Error state. Always says what to do; a bare failure message is a bug. */
export function ErrorNote({
  title, detail, action, onRetry,
}: { title: string; detail?: string; action?: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-md border border-warn/40 bg-warn-soft/60 px-4 py-3">
      <p className="text-sm font-medium text-ink">{title}</p>
      {detail ? <p className="mt-1 text-sm text-ink-soft">{detail}</p> : null}
      {action ? <p className="mt-1 text-sm text-ink-soft">{action}</p> : null}
      {onRetry ? (
        <button onClick={onRetry} className="label mt-2 text-accent hover:brightness-125">
          [ RETRY ]
        </button>
      ) : null}
    </div>
  );
}

/** Outcome pill. Colour is reinforced by the word, never replaced by it. */
export function StatusPill({ status }: { status: "PENDING" | "WON" | "LOST" | "VOID" | "FAILED" }) {
  const map = {
    PENDING: { text: "PENDING", cls: "border-border-strong text-ink-soft" },
    WON: { text: "WON", cls: "border-up/50 bg-up-soft text-up" },
    LOST: { text: "LOST", cls: "border-down/50 bg-down-soft text-down" },
    VOID: { text: "VOID", cls: "border-border-strong bg-surface-2 text-ink-soft" },
    FAILED: { text: "FAILED", cls: "border-warn/50 bg-warn-soft text-warn" },
  } as const;
  const s = map[status];
  return (
    <span
      className={`inline-flex rounded-sm border px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[0.625rem] font-medium uppercase tracking-wider ${s.cls}`}
    >
      {s.text}
    </span>
  );
}

/** A small live indicator: a pulsing dot plus the word, never the dot alone. */
export function LiveDot({ label = "LIVE" }: { label?: string }) {
  return (
    <span className="label inline-flex items-center gap-1.5 text-accent">
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-70" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
      </span>
      {label}
    </span>
  );
}
