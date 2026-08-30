import "server-only";

/**
 * Per-IP rate limiting for our own API routes.
 *
 * These routes are cheap to call and expensive to serve: each one can reach the
 * chain, the venue's indexer, or a serverless database. Left open, a single
 * script can exhaust the database's connection budget and take the site down
 * for everyone — which costs the attacker nothing.
 *
 * A token bucket, so a burst is allowed (a page load fires several requests at
 * once) but a sustained flood is not.
 *
 * HONEST LIMIT: this is in-process. On Vercel each serverless instance keeps
 * its own buckets, so the effective limit is per-instance rather than global,
 * and it resets on a cold start. That makes it a guard against accidents and
 * casual abuse, not a defence against a determined distributed attacker — that
 * needs a shared store (Redis) or the platform's own WAF. Stated here rather
 * than implied, so nobody mistakes it for more than it is.
 */

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const buckets = new Map<string, Bucket>();

/** Bound the map so a spray of forged IPs cannot grow it without limit. */
const MAX_TRACKED = 5_000;

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
}

export function rateLimit(
  key: string,
  { capacity = 30, refillPerSec = 1 }: { capacity?: number; refillPerSec?: number } = {},
): RateLimitResult {
  const now = Date.now();
  let bucket = buckets.get(key);

  if (!bucket) {
    // Evict the oldest entries rather than growing unboundedly. This is a
    // cheap guard, not an LRU: correctness here is "the map stays small".
    if (buckets.size >= MAX_TRACKED) {
      const cutoff = now - 60_000;
      for (const [k, b] of buckets) if (b.updatedAt < cutoff) buckets.delete(k);
      if (buckets.size >= MAX_TRACKED) buckets.clear();
    }
    bucket = { tokens: capacity, updatedAt: now };
    buckets.set(key, bucket);
  }

  // Refill for the time that has passed, capped at capacity.
  const elapsedSec = (now - bucket.updatedAt) / 1000;
  bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSec);
  bucket.updatedAt = now;

  if (bucket.tokens < 1) {
    return {
      ok: false,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerSec)),
    };
  }

  bucket.tokens -= 1;
  return { ok: true, remaining: Math.floor(bucket.tokens), retryAfterSec: 0 };
}

/**
 * Best-effort client identity.
 *
 * `x-forwarded-for` is trivially forged in general, but on Vercel the platform
 * sets it and the app is not reachable except through it. Falling back to a
 * single shared key is deliberate: if we cannot tell clients apart, limiting
 * them together is safer than not limiting at all.
 */
export function clientKey(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  const ip = fwd?.split(",")[0]?.trim();
  return ip && ip.length > 0 ? ip : "unknown";
}

/** Standard 429 with the headers a well-behaved client will honour. */
export function tooManyRequests(result: RateLimitResult): Response {
  return new Response(
    JSON.stringify({
      code: "RATE_LIMITED",
      message: "Too many requests from this address.",
      action: `Wait ${result.retryAfterSec}s and try again.`,
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(result.retryAfterSec),
        "cache-control": "no-store",
      },
    },
  );
}

/** Drop all state. Tests only. */
export function resetRateLimits(): void {
  buckets.clear();
}
