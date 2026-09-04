"use client";

/**
 * Your profile.
 *
 * Reached by connecting a wallet -- there is no sign-up, because the address IS
 * the account. Saving asks for a signature, which proves the wallet is yours
 * without a password and without the server ever holding anything secret.
 *
 * The form validates as you type, but that is only a courtesy: the server runs
 * the same rules again and its answer is the one that counts.
 */
import { useEffect, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import type { ProfileDto } from "@/lib/types";
import { Avatar } from "@/components/Avatar";
import { CopyAddress } from "@/components/CopyAddress";
import { Panel, Button, ErrorNote, Empty, Skeleton, Card } from "@/components/ui";
import { profileMessage } from "@/lib/signedMessage";
import { NetworkBanner } from "@/components/Wallet";

const BIO_MAX = 160;
const NAME_RE = /^[a-zA-Z0-9_-]{3,20}$/;

interface Draft {
  displayName: string;
  bio: string;
  twitter: string;
  website: string;
}


export default function SettingsPage() {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();

  const [draft, setDraft] = useState<Draft>({ displayName: "", bio: "", twitter: "", website: "" });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<{ message: string; action?: string } | null>(null);

  const profile = useQuery({
    queryKey: ["profile", address],
    queryFn: async (): Promise<ProfileDto> => {
      const r = await fetch(`/api/profile?wallet=${address}`, { cache: "no-store" });
      if (!r.ok) throw new Error("Could not load your profile.");
      return r.json();
    },
    enabled: Boolean(address),
  });

  // Seed the form from what is stored, once.
  useEffect(() => {
    if (!profile.data) return;
    setDraft({
      displayName: profile.data.displayName ?? "",
      bio: profile.data.bio ?? "",
      twitter: profile.data.twitter ?? "",
      website: profile.data.website ?? "",
    });
  }, [profile.data]);

  if (!isConnected || !address) {
    return (
      <>
        <h1 className="mb-4 text-lg font-bold uppercase tracking-tight text-ink">Your profile</h1>
        <Card>
          <Empty
            image="/img/office-window.jpg"
            title="Connect a wallet to edit your profile"
            hint="There is no sign-up. Your wallet address is the account, and a signature proves it is yours."
          />
        </Card>
      </>
    );
  }

  const nameOk = draft.displayName === "" || NAME_RE.test(draft.displayName);
  const bioOk = draft.bio.length <= BIO_MAX;
  const canSave = nameOk && bioOk && !busy;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      // The timestamp is inside the signed text, so the server can refuse a
      // replayed signature without trusting anything sent beside it.
      const issuedAt = new Date().toISOString();
      const signature = await signMessageAsync({ message: profileMessage(address, draft, issuedAt) });
      const r = await fetch("/api/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, profile: draft, signature, issuedAt }),
      });
      const body = await r.json();
      if (!r.ok) {
        setError({ message: body.message ?? "Could not save your profile.", action: body.action });
        return;
      }
      setSaved(true);
      void profile.refetch();
    } catch (err) {
      // Declining the signature is a choice, not a failure.
      const msg = err instanceof Error ? err.message : "";
      if (!/rejected|denied/i.test(msg)) setError({ message: "Could not sign that message." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <NetworkBanner />
      {/* A form is a reading task, not a dashboard: give it a measure and
          centre it rather than stretching inputs across the screen. */}
      <div className="mx-auto w-full max-w-3xl">
      <h1 className="mb-1 text-lg font-bold uppercase tracking-tight text-ink">Your profile</h1>
      <p className="mb-4 text-sm text-ink-soft">
        Shown on the leaderboard and your public page. All of it is optional.
      </p>

      <Panel label="IDENTITY" bodyClass="p-4">
        <div className="flex items-center gap-3">
          <Avatar address={address} size={52} />
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">
              {draft.displayName || "No name set"}
            </p>
            <CopyAddress address={address} />
            <p className="label mt-1">AVATAR GENERATED FROM YOUR ADDRESS</p>
          </div>
        </div>
      </Panel>

      <form onSubmit={save} className="mt-3 space-y-3">
        <Panel label="DETAILS" bodyClass="p-4 space-y-4">
          {profile.isPending ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <>
              <Field
                id="displayName"
                label="DISPLAY NAME"
                value={draft.displayName}
                onChange={(v) => setDraft((d) => ({ ...d, displayName: v }))}
                placeholder="satoshi"
                maxLength={20}
                hint="3 to 20 characters: letters, numbers, hyphen or underscore."
                invalid={!nameOk}
                invalidHint="That name has characters which are not allowed."
              />

              <div>
                <label htmlFor="bio" className="label block">BIO</label>
                <textarea
                  id="bio"
                  value={draft.bio}
                  onChange={(e) => setDraft((d) => ({ ...d, bio: e.target.value }))}
                  rows={3}
                  maxLength={BIO_MAX + 40}
                  placeholder="Calls the 5-minute windows. Mostly wrong, occasionally spectacular."
                  className="mt-1 w-full resize-y rounded-sm border border-border-strong bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-ink-faint"
                />
                <p className={`mt-1 text-xs ${bioOk ? "text-ink-faint" : "text-warn"}`}>
                  {draft.bio.length} / {BIO_MAX}
                </p>
              </div>

              <Field
                id="twitter"
                label="X HANDLE"
                value={draft.twitter}
                onChange={(v) => setDraft((d) => ({ ...d, twitter: v }))}
                placeholder="satoshi"
                maxLength={60}
                hint="Handle or full link. We store just the handle."
              />

              <Field
                id="website"
                label="WEBSITE"
                value={draft.website}
                onChange={(v) => setDraft((d) => ({ ...d, website: v }))}
                placeholder="example.com"
                maxLength={200}
                hint="http and https only."
              />
            </>
          )}
        </Panel>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={!canSave}>
            {busy ? "CHECK YOUR WALLET" : "SAVE PROFILE"}
          </Button>
          <Link href={`/p/${address}`} className="label text-ink-soft hover:text-ink">
            [ VIEW PUBLIC PAGE ]
          </Link>
        </div>

        <p className="text-xs leading-relaxed text-ink-faint">
          Saving asks your wallet to sign a message listing exactly these values. It is not a
          transaction: nothing is sent, nothing is spent, and no gas is used. The signature is what
          proves the wallet is yours.
        </p>

        {saved ? (
          <p className="rounded-sm border border-up/40 bg-up-soft px-3 py-2 text-sm text-ink">
            Profile saved.
          </p>
        ) : null}
        {error ? <ErrorNote title={error.message} {...(error.action ? { action: error.action } : {})} /> : null}
      </form>
      </div>
    </>
  );
}

function Field({
  id, label, value, onChange, placeholder, maxLength, hint, invalid, invalidHint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  maxLength?: number;
  hint?: string;
  invalid?: boolean;
  invalidHint?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="label block">{label}</label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        autoComplete="off"
        aria-invalid={invalid ? true : undefined}
        className={`mt-1 w-full rounded-sm border bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-ink-faint ${
          invalid ? "border-warn" : "border-border-strong"
        }`}
      />
      <p className={`mt-1 text-xs ${invalid ? "text-warn" : "text-ink-faint"}`}>
        {invalid ? invalidHint : hint}
      </p>
    </div>
  );
}
