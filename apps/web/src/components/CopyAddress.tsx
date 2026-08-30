"use client";

import { useState } from "react";
import { shortAddress } from "@/lib/format";

/** The address, one tap from the clipboard. */
export function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(address);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable; the text is still selectable */
        }
      }}
      className="tabular mt-0.5 text-xs text-ink-faint hover:text-ink-soft"
      title={address}
    >
      {copied ? "Address copied" : shortAddress(address)}
    </button>
  );
}
