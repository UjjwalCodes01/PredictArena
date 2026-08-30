"use client";

/**
 * Player avatar.
 *
 * Generated from the address rather than uploaded: every wallet gets a
 * distinct, stable image with no upload flow, no moderation problem, and no
 * external service that could be down during a demo. This is the identicon
 * pattern crypto interfaces have used for years, and it means a list of
 * addresses becomes visually scannable.
 *
 * Deterministic: the same address always produces the same picture, so people
 * recognise each other across pages.
 */
type Props = { address: string; size?: number; className?: string };

/** FNV-1a: small, fast, and stable across runtimes. */
function hash(input: string): number {
  let h = 2_166_136_261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return h >>> 0;
}

export function Avatar({ address, size = 32, className = "" }: Props) {
  const seed = hash(address.toLowerCase());
  const hue = seed % 360;
  const hue2 = (hue + 40 + (seed % 80)) % 360;

  // A 5x5 grid, mirrored down the middle so the shape reads as a face/emblem
  // rather than noise.
  const cells: boolean[] = [];
  for (let i = 0; i < 15; i += 1) cells.push(((seed >> i) & 1) === 1);

  const rects: Array<{ x: number; y: number }> = [];
  for (let col = 0; col < 3; col += 1) {
    for (let row = 0; row < 5; row += 1) {
      if (!cells[col * 5 + row]) continue;
      rects.push({ x: col, y: row });
      if (col < 2) rects.push({ x: 4 - col, y: row });
    }
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 5 5"
      className={`shrink-0 rounded-full ${className}`}
      role="img"
      aria-label={`Avatar for ${address.slice(0, 6)}`}
      shapeRendering="crispEdges"
    >
      <rect width="5" height="5" fill={`hsl(${hue} 62% 92%)`} />
      {rects.map((r, i) => (
        <rect
          key={i}
          x={r.x}
          y={r.y}
          width="1"
          height="1"
          fill={i % 3 === 0 ? `hsl(${hue2} 58% 52%)` : `hsl(${hue} 58% 45%)`}
        />
      ))}
    </svg>
  );
}
