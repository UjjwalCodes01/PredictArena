"use client";

/**
 * Copy a link to this player's page.
 *
 * A share sheet is overkill: the useful action is "give me the URL". Falls back
 * to selecting the text when the clipboard is unavailable (older browsers, or a
 * page not served over HTTPS), so the button is never a dead end.
 */
import { useState } from "react";
import { Button } from "./ui";

export function ShareButton({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  const copy = async () => {
    const url = `${window.location.origin}/p/${address}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setFailed(false);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setFailed(true);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="secondary" onClick={copy}>
        {copied ? "Link copied" : "Share"}
      </Button>
      {failed ? (
        <p className="text-xs text-ink-faint">
          Copy this address bar link to share.
        </p>
      ) : null}
    </div>
  );
}
