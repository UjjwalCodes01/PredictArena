import { ImageResponse } from "next/og";
import { getStandings, currentWeekId, normalizeAddress } from "@predictarena/db";
import { serverDb } from "@/lib/server";

export const runtime = "nodejs";
export const alt = "Prediction Leagues player card";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * The share card.
 *
 * Rendered per player so a link posted anywhere carries the number that makes
 * someone click: a rank and a streak. Deliberately plain -- no emoji, no
 * gradients, large type that survives being shown as a thumbnail.
 */
export default async function OpenGraphImage({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  // Next 15+ hands route params in as a Promise.
  const { address } = await params;
  const short = `${address.slice(0, 6)}\u2026${address.slice(-4)}`;

  let rank: string = "\u2014";
  let points: string = "0";
  let record: string = "0-0";
  let streak = 0;

  try {
    const standings = await getStandings(serverDb(), currentWeekId());
    const me = standings.find((s) => s.wallet === normalizeAddress(address));
    if (me) {
      rank = `#${me.rank}`;
      points = String(me.points);
      record = `${me.wins}-${me.losses}`;
      streak = me.currentStreak;
    }
  } catch {
    // A card that renders with placeholders beats a broken image in a timeline.
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%", height: "100%", display: "flex", flexDirection: "column",
          justifyContent: "space-between", padding: 72,
          background: "#ffffff", color: "#16191d",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 26, color: "#6b7280", letterSpacing: -0.2 }}>
            Prediction Leagues
          </div>
          <div style={{ fontSize: 64, fontWeight: 700, letterSpacing: -1.5 }}>{short}</div>
        </div>

        <div style={{ display: "flex", gap: 64 }}>
          <Figure label="Rank" value={rank} />
          <Figure label="Points" value={points} />
          <Figure label="Record" value={record} />
          {streak >= 2 ? <Figure label="Streak" value={`${streak} in a row`} /> : null}
        </div>

        <div style={{ fontSize: 24, color: "#6b7280" }}>
          Up or Down on BTC and ETH. Somnia Shannon testnet.
        </div>
      </div>
    ),
    size,
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ fontSize: 24, color: "#6b7280" }}>{label}</div>
      <div style={{ fontSize: 56, fontWeight: 600, letterSpacing: -1 }}>{value}</div>
    </div>
  );
}
