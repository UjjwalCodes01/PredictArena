"use client";

/**
 * Claim a display name.
 *
 * Signing proves the wallet is yours. It is not a transaction: nothing is sent
 * and nothing is spent, which the copy says plainly because a wallet popup
 * otherwise reads as "you are about to pay for something".
 */
import { useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { Button, ErrorNote } from "./ui";

function claimMessage(address: string, name: string): string {
  return `Prediction Leagues\n\nClaim the name "${name}" for ${address.toLowerCase()}.\n\nThis is a signature, not a transaction. It costs nothing and moves nothing.`;
}

export function ClaimNameForm({
  currentName,
  onSaved,
}: {
  currentName: string | null;
  onSaved: (name: string) => void;
}) {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [name, setName] = useState(currentName ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; action?: string } | null>(null);
  const [saved, setSaved] = useState(false);

  const valid = /^[a-zA-Z0-9_-]{3,20}$/.test(name.trim());

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!address || !valid || busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const signature = await signMessageAsync({ message: claimMessage(address, name.trim()) });
      const r = await fetch("/api/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, name: name.trim(), signature }),
      });
      const body = await r.json();
      if (!r.ok) {
        setError({ message: body.message ?? "Could not save that name.", action: body.action });
        return;
      }
      setSaved(true);
      onSaved(body.displayName);
    } catch (e) {
      // Declining the signature is a choice, not a failure.
      const msg = e instanceof Error ? e.message : "";
      if (/rejected|denied/i.test(msg)) setError(null);
      else setError({ message: "Could not sign that message." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-2">
      <label htmlFor="displayName" className="block text-sm font-medium text-ink">
        {currentName ? "Change your name" : "Choose a display name"}
      </label>
      <div className="flex gap-2">
        <input
          id="displayName"
          value={name}
          onChange={(e) => { setName(e.target.value); setSaved(false); }}
          placeholder="satoshi"
          maxLength={20}
          autoComplete="off"
          className="min-w-0 flex-1 rounded-lg border border-border-strong bg-surface px-3 py-2.5 text-sm text-ink placeholder:text-ink-faint"
        />
        <Button type="submit" disabled={!valid || busy}>
          {busy ? "Check your wallet" : "Save"}
        </Button>
      </div>
      <p className="text-xs text-ink-faint">
        3 to 20 characters: letters, numbers, hyphen or underscore. You will sign a message to prove
        the wallet is yours — it costs nothing and sends nothing.
      </p>
      {saved ? <p className="text-sm text-up">Saved.</p> : null}
      {error ? <ErrorNote title={error.message} {...(error.action ? { action: error.action } : {})} /> : null}
    </form>
  );
}
