/**
 * Rebuilding windows from the chain alone.
 *
 * This path exists because the venue's GraphQL indexer is a single point of
 * failure: when `listLiveBinaryMarkets` hangs, nobody can see a window and
 * nobody can place a call. Measured in production — a bare
 * `Market(limit:1){id}` timing out at 31s while an invalid field errored in
 * 1.6s.
 *
 * The property that makes it safe to ship is that the CHAIN still decides
 * everything that matters. The candidate list only says which markets to look
 * at; if it is stale, the chain corrects it. That is what these tests pin.
 */
import { describe, expect, it, vi } from "vitest";
import { getWindowsFromCandidates, MarketStatus, type WindowCandidate } from "../windows";
import type { DexClient } from "../client";

const NOW = 1_800_000_000;

/** Minimal client: the function only touches the clock and one chain read. */
function stubClient(onchainById: Record<string, unknown>, opts: { failIds?: string[] } = {}) {
  const getMarketOnchain = vi.fn(async (id: string) => {
    if (opts.failIds?.includes(id)) throw new Error("not readable");
    const row = onchainById[id];
    if (!row) throw new Error("unknown market");
    return row;
  });
  return {
    clock: {
      ensureFresh: async () => {},
      secondsUntil: (at: number) => at - NOW,
      nowSec: () => NOW,
    },
    queue: { run: <T>(fn: () => Promise<T>) => fn() },
    exchange: { client: { getMarketOnchain } },
  } as unknown as DexClient & { exchange: { client: { getMarketOnchain: typeof getMarketOnchain } } };
}

function onchain(over: Record<string, unknown> = {}) {
  return {
    pool: "0xpool000000000000000000000000000000000000",
    status: MarketStatus.Trading,
    expiry: BigInt(NOW + 600),
    winningOutcome: 0,
    isResolved: false,
    isVoided: false,
    decimals: 6,
    ...over,
  };
}

const candidate = (id: string, over: Partial<WindowCandidate> = {}): WindowCandidate => ({
  marketId: id as `0x${string}`,
  asset: "BTC",
  intervalSec: 300,
  ...over,
});

describe("getWindowsFromCandidates", () => {
  it("takes the close time from the CHAIN, not from the candidate", async () => {
    // The whole point. A projection can lag, and the countdown is the one
    // number a player acts on — so a stale candidate must not set it.
    const client = stubClient({ "0xa": onchain({ expiry: BigInt(NOW + 900) }) });
    const [w] = await getWindowsFromCandidates(client, [
      candidate("0xa", { opensAtSec: 1 }),
    ]);
    expect(w?.closesAtSec).toBe(NOW + 900);
    expect(w?.secondsLeft).toBe(900);
  });

  it("reports a window the chain says has closed, however the projection labelled it", async () => {
    const client = stubClient({ "0xa": onchain({ status: MarketStatus.Trading, expiry: BigInt(NOW - 10) }) });
    const [w] = await getWindowsFromCandidates(client, [candidate("0xa")], { includeUntradable: true });
    expect(w?.isTradable).toBe(false);
  });

  it("excludes a market that is not trading", async () => {
    const client = stubClient({ "0xa": onchain({ status: MarketStatus.Resolved }) });
    expect(await getWindowsFromCandidates(client, [candidate("0xa")])).toEqual([]);
  });

  it("keeps an untradable window when asked, for views that show them", async () => {
    const client = stubClient({ "0xa": onchain({ status: MarketStatus.Resolved }) });
    const out = await getWindowsFromCandidates(client, [candidate("0xa")], { includeUntradable: true });
    expect(out).toHaveLength(1);
    expect(out[0]?.isTradable).toBe(false);
  });

  it("skips a candidate it cannot read rather than failing the whole list", async () => {
    // A stale projection names markets that no longer exist. One bad id must
    // not cost the player every other window.
    const client = stubClient(
      { "0xa": onchain(), "0xc": onchain() },
      { failIds: ["0xb"] },
    );
    const out = await getWindowsFromCandidates(client, [
      candidate("0xa"), candidate("0xb"), candidate("0xc"),
    ]);
    expect(out.map((w) => w.marketId)).toEqual(["0xa", "0xc"]);
  });

  it("returns nothing, rather than throwing, when every candidate is unreadable", async () => {
    const client = stubClient({}, { failIds: ["0xa", "0xb"] });
    await expect(
      getWindowsFromCandidates(client, [candidate("0xa"), candidate("0xb")]),
    ).resolves.toEqual([]);
  });

  it("uses the pool address the chain reports", async () => {
    // Pools are recycled across windows, so a remembered pool is a real hazard.
    const client = stubClient({ "0xa": onchain({ pool: "0xfresh" }) });
    const [w] = await getWindowsFromCandidates(client, [candidate("0xa")]);
    expect(w?.pool).toBe("0xfresh");
  });

  it("states the series plainly when no question text is available", async () => {
    const client = stubClient({ "0xa": onchain() });
    const [w] = await getWindowsFromCandidates(client, [candidate("0xa", { asset: "ETH" })]);
    expect(w?.question).toBe("Will ETH close at or above its opening price?");
  });

  it("prefers a real question when one was carried through", async () => {
    const client = stubClient({ "0xa": onchain() });
    const [w] = await getWindowsFromCandidates(client, [
      candidate("0xa", { question: "Venue's own wording" }),
    ]);
    expect(w?.question).toBe("Venue's own wording");
  });

  it("orders by close time, soonest first", async () => {
    const client = stubClient({
      "0xlate": onchain({ expiry: BigInt(NOW + 900) }),
      "0xsoon": onchain({ expiry: BigInt(NOW + 120) }),
    });
    const out = await getWindowsFromCandidates(client, [candidate("0xlate"), candidate("0xsoon")]);
    expect(out.map((w) => w.marketId)).toEqual(["0xsoon", "0xlate"]);
  });

  it("does no work at all for an empty candidate list", async () => {
    const client = stubClient({});
    await expect(getWindowsFromCandidates(client, [])).resolves.toEqual([]);
    expect(client.exchange.client.getMarketOnchain).not.toHaveBeenCalled();
  });
});
