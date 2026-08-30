"use client";

import { useState } from "react";
import { WindowFeed } from "@/components/WindowFeed";
import { MyCalls } from "@/components/MyCalls";
import { NetworkBanner } from "@/components/Wallet";

export default function HomePage() {
  // Bumped when a call lands, so the list below refetches immediately rather
  // than waiting for its next poll.
  const [placed, setPlaced] = useState(0);

  return (
    <>
      <NetworkBanner />

      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight text-ink">
          Call the next move
        </h1>
        <p className="mt-1 text-sm text-ink-soft">
          Pick a direction before the window closes. Win to build a streak and climb this
          week&apos;s board.
        </p>
      </div>

      <WindowFeed onPlaced={() => setPlaced((n) => n + 1)} />
      <MyCalls refreshKey={placed} />
    </>
  );
}
