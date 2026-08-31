"use client";

import { useCallback, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useAccount } from "wagmi";
import { WindowFeed } from "@/components/WindowFeed";
import { SidePanel } from "@/components/SidePanel";
import { NetworkBanner } from "@/components/Wallet";
import { Card } from "@/components/ui";

export default function HomePage() {
  const { isConnected } = useAccount();
  // Bumped when a call lands so the list refetches at once rather than waiting
  // for its next poll.
  const [placed, setPlaced] = useState(0);
  // Stable identity. An inline arrow here is a new function every render, which
  // is what turned the child's effect into a render loop.
  const handlePlaced = useCallback(() => setPlaced((n) => n + 1), []);

  return (
    <>
      <NetworkBanner />

      <div className="mb-5 overflow-hidden rounded-xl border border-border">
        <div className="relative h-36 w-full sm:h-44 lg:h-56">
          <Image
            src="/img/chart-candles-dark.jpg"
            alt=""
            fill
            priority
            sizes="(max-width: 672px) 100vw, 672px"
            className="object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/50 to-black/25" />
          <div className="absolute inset-0 flex flex-col justify-end p-4">
            <h1 className="text-xl font-semibold tracking-tight text-white sm:text-2xl lg:text-3xl">
              Call the next move
            </h1>
            <p className="mt-1 max-w-md text-sm text-white/85">
              Pick a direction before the window closes. Win to build a streak and climb this
              week&apos;s board.
            </p>
          </div>
        </div>
      </div>

      {/*
        Two columns from lg up: the decision on the left, your record on the
        right. Below that they stack in the same order, so a phone still reads
        top to bottom as act-then-review.

        The action column is wider because it holds the only thing on this page
        with a deadline attached.
      */}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] xl:gap-6">
        <div className="min-w-0">
          <WindowFeed onPlaced={handlePlaced} />
        </div>
        <div className="min-w-0">
          <SidePanel refreshKey={placed} />
        </div>
      </div>

      {/* Newcomers get an explanation; returning players never see it. */}
      {!isConnected ? (
        <section aria-label="About the league" className="mt-10">
          <h2 className="label mb-2">HOW THE LEAGUE WORKS</h2>
          <div className="grid gap-3 sm:grid-cols-3 lg:gap-4">
            <Explainer
              image="/img/app-markets-phone.jpg"
              title="One tap"
              body="Every window asks one question: higher or lower than it opened."
            />
            <Explainer
              image="/img/keyboard-charts.jpg"
              title="It settles itself"
              body="The window closes, the chain decides, and your result appears."
            />
            <Explainer
              image="/img/coins-stacking.jpg"
              title="Streaks pay more"
              body="Three in a row scores 15 a win. Five in a row scores 20."
            />
          </div>
          <p className="mt-3 text-sm text-ink-soft">
            New here?{" "}
            <Link href="/start" className="text-accent underline underline-offset-2">
              Getting started
            </Link>{" "}
            walks through it in four steps.
          </p>
        </section>
      ) : null}
    </>
  );
}

function Explainer({ image, title, body }: { image: string; title: string; body: string }) {
  return (
    <Card className="overflow-hidden">
      <div className="relative h-24 w-full">
        <Image src={image} alt="" fill sizes="(max-width: 672px) 33vw, 220px" className="object-cover" />
      </div>
      <div className="p-3">
        <p className="text-sm font-medium text-ink">{title}</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-soft">{body}</p>
      </div>
    </Card>
  );
}
