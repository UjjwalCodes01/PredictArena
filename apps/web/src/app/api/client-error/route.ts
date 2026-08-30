import { NextResponse } from "next/server";
import { rateLimit, clientKey, tooManyRequests } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

/**
 * Where browser errors go.
 *
 * Server errors already land in the platform's log stream; client errors
 * previously died in the user's console where nobody would ever see them. That
 * is the half of the app most likely to break in ways we cannot reproduce —
 * one wallet extension, one browser, one network.
 *
 * This writes a structured line to stdout, which Vercel ingests and can alert
 * on. If `SENTRY_DSN` is set the same payload is forwarded there too, so
 * adopting Sentry is a matter of setting one variable rather than a code
 * change.
 *
 * Deliberately NOT a general logging endpoint: it is rate-limited, it caps
 * every field, and it records nothing the page did not already know. No wallet
 * address, no balances — an error report must not become a tracking channel.
 */

const MAX_MESSAGE = 500;
const MAX_STACK = 2_000;
const MAX_URL = 300;

interface ClientError {
  message?: unknown;
  stack?: unknown;
  url?: unknown;
  digest?: unknown;
}

const str = (v: unknown, cap: number): string =>
  typeof v === "string" ? v.slice(0, cap) : "";

export async function POST(request: Request): Promise<NextResponse> {
  // Tight budget: a page in an error loop must not become a log flood.
  const limit = rateLimit(`err:${clientKey(request)}`, { capacity: 5, refillPerSec: 0.1 });
  if (!limit.ok) return tooManyRequests(limit) as never;

  let body: ClientError;
  try {
    body = (await request.json()) as ClientError;
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const report = {
    level: "error",
    source: "browser",
    at: new Date().toISOString(),
    message: str(body.message, MAX_MESSAGE) || "unknown client error",
    stack: str(body.stack, MAX_STACK),
    url: str(body.url, MAX_URL),
    digest: str(body.digest, 100),
    userAgent: (request.headers.get("user-agent") ?? "").slice(0, 200),
  };

  // One JSON line per error — greppable, and what log aggregators expect.
  // eslint-disable-next-line no-console -- this endpoint's whole purpose
  console.error(JSON.stringify(report));

  const dsn = process.env["SENTRY_DSN"];
  if (dsn) {
    // Forwarded fire-and-forget: a slow or broken Sentry must not make the
    // browser wait, and must not turn one error into two.
    void forwardToSentry(dsn, report).catch(() => {});
  }

  return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}

/**
 * Post to Sentry's store endpoint directly.
 *
 * No SDK: the payload is small and well-specified, and pulling in
 * `@sentry/nextjs` for one POST would add build weight and a config surface for
 * something that must never be load-bearing.
 */
async function forwardToSentry(dsn: string, report: Record<string, string>): Promise<void> {
  // https://<key>@<host>/<projectId>
  const m = /^https:\/\/([^@]+)@([^/]+)\/(.+)$/.exec(dsn);
  if (!m) return;
  const [, key, host, projectId] = m;

  await fetch(`https://${host}/api/${projectId}/store/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${key}, sentry_client=prediction-leagues/1.0`,
    },
    body: JSON.stringify({
      message: report["message"],
      level: "error",
      platform: "javascript",
      timestamp: report["at"],
      extra: report,
    }),
    signal: AbortSignal.timeout(4_000),
  });
}
