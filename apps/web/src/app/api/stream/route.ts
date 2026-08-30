import { getWalletCalls, normalizeAddress } from "@predictarena/db";
import { serverDb } from "@/lib/server";

export const dynamic = "force-dynamic";
// A stream must not be buffered by the framework or any proxy in front of it.
export const fetchCache = "force-no-store";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** How often the server looks for a change. The CLIENT never polls. */
const CHECK_MS = 3_000;
/**
 * Serverless platforms cap a function's wall time. Closing cleanly a little
 * before that cap means the browser reconnects on our terms rather than seeing
 * a truncated stream.
 */
const MAX_LIFETIME_MS = 240_000;
/** Keeps intermediaries from dropping an idle connection. */
const HEARTBEAT_MS = 20_000;

/**
 * Live settlement updates for one wallet.
 *
 * AGENTS.md prefers a push channel over polling for this, and the difference is
 * visible: a settled call appears the moment the indexer records it, rather
 * than up to a poll interval later.
 *
 * What is pushed is deliberately thin -- a fingerprint of the wallet's call
 * statuses, not the calls themselves. The browser re-reads through the normal
 * endpoint when it changes, so there is exactly one code path that shapes call
 * data and no chance of the two disagreeing.
 *
 * Polling remains the guarantee. The client keeps a slow interval running, so
 * if this stream is blocked by a proxy or capped by the platform, settlement
 * still lands -- just later.
 */
export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const wallet = searchParams.get("wallet");

  if (!wallet || !ADDRESS.test(wallet)) {
    return new Response("A valid wallet address is required.", { status: 400 });
  }
  const address = normalizeAddress(wallet);

  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let lifetime: ReturnType<typeof setTimeout> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
        } catch {
          closed = true;
        }
      };

      const shutdown = (): void => {
        if (closed) return;
        closed = true;
        if (timer) clearInterval(timer);
        if (heartbeat) clearInterval(heartbeat);
        if (lifetime) clearTimeout(lifetime);
        try {
          controller.close();
        } catch {
          /* already closed by the client going away */
        }
      };

      // A fingerprint, not the payload: id+status is enough to know something
      // settled, and keeps this endpoint from becoming a second shape of the
      // same data.
      const fingerprint = async (): Promise<string> => {
        const calls = await getWalletCalls(serverDb(), address, 50);
        return calls.map((c) => `${c.id}:${c.status}`).join("|");
      };

      // The database is serverless and suspends when idle, so the FIRST read
      // after a quiet period can time out. Failing the stream on that would
      // send every client into a reconnect loop at exactly the moment the
      // database is waking up.
      let last = "";
      let opened = false;
      for (let attempt = 1; attempt <= 3 && !closed; attempt += 1) {
        try {
          last = await fingerprint();
          opened = true;
          break;
        } catch {
          if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1_500));
        }
      }

      if (!opened) {
        send("error", JSON.stringify({ message: "Could not open the live stream." }));
        shutdown();
        return;
      }

      send("ready", JSON.stringify({ calls: last === "" ? 0 : last.split("|").length }));

      timer = setInterval(() => {
        void (async () => {
          try {
            const now = await fingerprint();
            if (now !== last) {
              last = now;
              send("changed", JSON.stringify({ at: Date.now() }));
            }
          } catch {
            // A transient database blip must not kill the stream; the next
            // tick tries again, and the client's fallback poll covers the gap.
          }
        })();
      }, CHECK_MS);

      heartbeat = setInterval(() => send("ping", "{}"), HEARTBEAT_MS);
      lifetime = setTimeout(shutdown, MAX_LIFETIME_MS);

      // The browser navigating away or closing the tab aborts the request.
      request.signal.addEventListener("abort", shutdown);
    },
    cancel() {
      if (timer) clearInterval(timer);
      if (heartbeat) clearInterval(heartbeat);
      if (lifetime) clearTimeout(lifetime);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Nginx buffers proxied responses by default, which would hold every
      // event until the stream ends -- exactly defeating the point.
      "x-accel-buffering": "no",
    },
  });
}
