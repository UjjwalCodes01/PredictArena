"use client";

/**
 * Site chrome.
 *
 * One row of primary destinations that scrolls sideways on a narrow screen --
 * no hamburger, no drawer, nothing to discover. A menu you have to open is a
 * menu people do not use, and on a 390px phone the whole set still fits within
 * a thumb's reach.
 *
 * "Your calls" only appears once a wallet is connected: an empty destination is
 * worse than no destination.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAccount } from "wagmi";
import { ConnectButton } from "./Wallet";

const PRIMARY = [
  { href: "/", label: "Play" },
  { href: "/markets", label: "Markets" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/activity", label: "Activity" },
] as const;

export function SiteHeader() {
  const pathname = usePathname();
  const { isConnected } = useAccount();

  const items = isConnected
    ? [...PRIMARY, { href: "/portfolio", label: "Your calls" } as const]
    : PRIMARY;

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-bg/85 backdrop-blur">
      <div className="mx-auto flex w-full max-w-2xl items-center gap-3 px-4 py-3">
        <Link href="/" className="shrink-0 text-sm font-semibold tracking-tight text-ink">
          Prediction Leagues
        </Link>
        <div className="ml-auto">
          <ConnectButton />
        </div>
      </div>

      <nav
        aria-label="Main"
        className="mx-auto w-full max-w-2xl overflow-x-auto px-4 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <ul className="flex items-center gap-1">
          {items.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`block whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm transition-colors ${
                    active ? "bg-accent-soft font-medium text-accent" : "text-ink-soft hover:text-ink"
                  }`}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-border">
      <div className="mx-auto flex w-full max-w-2xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-6 text-sm text-ink-soft">
        <Link href="/how-it-works" className="hover:text-ink">
          How it works
        </Link>
        <Link href="/start" className="hover:text-ink">
          Get started
        </Link>
        <a
          href="https://shannon-explorer.somnia.network"
          target="_blank"
          rel="noreferrer noopener"
          className="hover:text-ink"
        >
          Explorer
        </a>
        <a
          href="https://unsplash.com/license"
          target="_blank"
          rel="noreferrer noopener"
          className="hover:text-ink"
        >
          Photos: Unsplash
        </a>
        <span className="ml-auto text-xs text-ink-faint">
          Somnia Shannon testnet. Test funds only.
        </span>
      </div>
    </footer>
  );
}
