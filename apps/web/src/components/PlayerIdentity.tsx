"use client";

/**
 * How a player is shown, everywhere.
 *
 * A claimed name plus the truncated address, never a name alone: the address is
 * the real identity and a name is a label someone chose. Showing only the name
 * would let a convincing handle stand in for the wallet it does not belong to.
 */
import Link from "next/link";
import { Avatar } from "./Avatar";
import { shortAddress } from "@/lib/format";

export function PlayerIdentity({
  address,
  displayName,
  size = 32,
  link = true,
  you = false,
  ai = false,
}: {
  address: string;
  displayName?: string | null;
  size?: number;
  link?: boolean;
  you?: boolean;
  /** Marks the AI forecaster. A label only — it is scored like everyone else. */
  ai?: boolean;
}) {
  const inner = (
    <span className="flex min-w-0 items-center gap-2.5">
      <Avatar address={address} size={size} />
      <span className="min-w-0">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-ink">
            {displayName ?? shortAddress(address)}
          </span>
          {you ? <span className="shrink-0 text-xs font-normal text-accent">You</span> : null}
          {ai ? (
            <span
              className="label shrink-0 rounded-sm bg-surface-2 px-1 py-0.5 text-ink-soft"
              title="The AI forecaster. Same board, same rules, same scoring."
            >
              AI
            </span>
          ) : null}
        </span>
        {displayName ? (
          <span className="tabular block truncate text-xs text-ink-faint">
            {shortAddress(address)}
          </span>
        ) : null}
      </span>
    </span>
  );

  if (!link) return inner;
  return (
    <Link href={`/p/${address}`} className="block min-w-0 hover:opacity-80">
      {inner}
    </Link>
  );
}
