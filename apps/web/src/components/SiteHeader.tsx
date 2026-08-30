"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "./Wallet";

const NAV = [
  { href: "/", label: "Play" },
  { href: "/leaderboard", label: "Leaderboard" },
] as const;

export function SiteHeader() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-bg/85 backdrop-blur">
      <div className="mx-auto flex w-full max-w-2xl items-center gap-4 px-4 py-3">
        <Link href="/" className="text-sm font-semibold tracking-tight text-ink">
          Prediction Leagues
        </Link>

        <nav className="flex items-center gap-1" aria-label="Main">
          {NAV.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`rounded-md px-2.5 py-1.5 text-sm transition-colors ${
                  active ? "bg-accent-soft font-medium text-accent" : "text-ink-soft hover:text-ink"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto">
          <ConnectButton />
        </div>
      </div>
    </header>
  );
}
