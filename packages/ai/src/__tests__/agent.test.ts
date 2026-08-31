/**
 * The agent's control flow, against a stubbed venue.
 *
 * The model call and the chain are both mocked here — what is under test is
 * the branching, which is where the real risk lives: a budget that must stop
 * it trading twice, an order that goes out and comes back empty, a window it
 * has already forecast, and a log write that must record what actually
 * happened rather than what was intended.
 *
 * The invariant every case checks: a forecast is recorded EXACTLY once per
 * window, and the row's action matches what really occurred.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dex = vi.hoisted(() => ({
  getWindows: vi.fn(),
  getTopOfBook: vi.fn(),
  quoteCall: vi.fn(),
  placeCall: vi.fn(),
}));
const model = vi.hoisted(() => ({ forecastWindow: vi.fn(), isConfigured: vi.fn(() => true) }));
/** Typed so the recorded row can be asserted on without casts at every call. */
type Row = Record<string, unknown>;
const store = vi.hoisted(() => ({
  recordForecast: vi.fn<(db: unknown, row: Record<string, unknown>) => Promise<void>>(),
  forecastedWindowIds: vi.fn<(db: unknown, w: string, ids: readonly string[]) => Promise<Set<string>>>(),
  getResolvedHistory: vi.fn<(db: unknown, asset: string, n?: number) => Promise<unknown[]>>(),
}));

/** The row written by the nth recordForecast call. */
function recorded(n = 0): Row {
  const call = store.recordForecast.mock.calls[n];
  if (!call) throw new Error(`no recordForecast call at index ${n}`);
  return call[1];
}

vi.mock("@predictarena/dex", async () => {
  const actual = await vi.importActual<typeof import("@predictarena/dex")>("@predictarena/dex");
  return {
    ...actual,
    getWindows: dex.getWindows,
    getTopOfBook: dex.getTopOfBook,
    quoteCall: dex.quoteCall,
    placeCall: dex.placeCall,
  };
});

vi.mock("@predictarena/db", async () => {
  const actual = await vi.importActual<typeof import("@predictarena/db")>("@predictarena/db");
  return {
    ...actual,
    recordForecast: store.recordForecast,
    forecastedWindowIds: store.forecastedWindowIds,
    getResolvedHistory: store.getResolvedHistory,
  };
});

vi.mock("../forecast", () => ({
  forecastWindow: model.forecastWindow,
  isConfigured: model.isConfigured,
}));

const { runAgent } = await import("../agent");
const { DexError } = await import("@predictarena/dex");

const WALLET = "0x1111111111111111111111111111111111111111" as const;
const STAKE = 1_000_000n;

function window(id: string, asset = "BTC", secondsLeft = 240) {
  return {
    marketId: id as `0x${string}`,
    asset,
    pool: "0x2222222222222222222222222222222222222222" as `0x${string}`,
    question: `Will ${asset} close up?`,
    intervalSec: 300,
    secondsLeft,
    closesAtSec: 1_800_000_000,
    isTradable: true,
  };
}

/** A forecast with enough edge over a 55c book to clear the HIGH threshold. */
function confident(upBps = 7_500) {
  return {
    forecast: { probabilityUpBps: upBps, confidence: "HIGH" as const, rationale: "r", keyFactors: ["k"] },
    inputTokens: 100,
    outputTokens: 50,
  };
}

const opts = () =>
  ({
    dex: { collateral: { decimals: 6 } },
    db: {},
    wallet: WALLET,
    stake: STAKE,
    assets: ["BTC"],
  }) as unknown as Parameters<typeof runAgent>[0];

beforeEach(() => {
  vi.clearAllMocks();
  model.isConfigured.mockReturnValue(true);
  store.forecastedWindowIds.mockResolvedValue(new Set());
  store.getResolvedHistory.mockResolvedValue([]);
  store.recordForecast.mockResolvedValue(undefined);
  dex.getTopOfBook.mockResolvedValue({ up: 550_000n, down: 430_000n });
  dex.quoteCall.mockResolvedValue({ quantity: 2_000_000n, escrow: STAKE });
  dex.placeCall.mockResolvedValue({ txHash: "0xdeadbeef", filled: 2_000_000n });
});

describe("runAgent", () => {
  it("does nothing at all without a key", async () => {
    model.isConfigured.mockReturnValue(false);
    const run = await runAgent(opts());
    expect(run.forecast).toBe(0);
    expect(dex.getWindows).not.toHaveBeenCalled();
    expect(store.recordForecast).not.toHaveBeenCalled();
  });

  it("forecasts, places, and records the placement with its tx", async () => {
    dex.getWindows.mockResolvedValue([window("0xaaa")]);
    model.forecastWindow.mockResolvedValue(confident());

    const run = await runAgent(opts());

    expect(run.placed).toBe(1);
    expect(dex.placeCall).toHaveBeenCalledOnce();
    expect(store.recordForecast).toHaveBeenCalledOnce();
    const row = recorded();
    expect(row["action"]).toBe("PLACE");
    expect(row["side"]).toBe("UP");
    expect(row["txHash"]).toBe("0xdeadbeef");
    // The book at the moment of the call is pinned, so the edge stays checkable.
    expect(row["askUp"]).toBe("550000");
  });

  it("records a pass, with its reason, when the market already agrees", async () => {
    dex.getWindows.mockResolvedValue([window("0xaaa")]);
    model.forecastWindow.mockResolvedValue(confident(5_600));

    const run = await runAgent(opts());

    expect(run.placed).toBe(0);
    expect(run.passed).toBe(1);
    expect(dex.placeCall).not.toHaveBeenCalled();
    const row = recorded();
    expect(row["action"]).toBe("PASS");
    expect(row["passReason"]).toBe("NO_EDGE");
    expect(row["txHash"]).toBeNull();
  });

  it("never forecasts a window it has already seen", async () => {
    dex.getWindows.mockResolvedValue([window("0xaaa"), window("0xbbb")]);
    store.forecastedWindowIds.mockResolvedValue(new Set(["0xaaa"]));
    model.forecastWindow.mockResolvedValue(confident());

    const run = await runAgent(opts());

    expect(run.forecast).toBe(1);
    expect(store.recordForecast).toHaveBeenCalledOnce();
    expect(recorded()["windowId"]).toBe("0xbbb");
  });

  it("does nothing rather than risk a double call when the log is unreadable", async () => {
    dex.getWindows.mockResolvedValue([window("0xaaa")]);
    store.forecastedWindowIds.mockRejectedValue(new Error("db down"));

    const run = await runAgent(opts());

    expect(run.forecast).toBe(0);
    expect(dex.placeCall).not.toHaveBeenCalled();
    expect(store.recordForecast).not.toHaveBeenCalled();
  });

  it("respects the placement budget but still records the estimate honestly", async () => {
    dex.getWindows.mockResolvedValue([window("0xaaa"), window("0xbbb")]);
    model.forecastWindow.mockResolvedValue(confident());

    const run = await runAgent({ ...opts(), maxForecasts: 2, maxPlacements: 1 });

    expect(run.placed).toBe(1);
    expect(dex.placeCall).toHaveBeenCalledOnce();
    // Both estimates are on the record; the second says why it was not acted on.
    expect(store.recordForecast).toHaveBeenCalledTimes(2);
    expect([recorded(0)["action"], recorded(1)["action"]]).toEqual(["PLACE", "PASS"]);
    expect(recorded(1)["passReason"]).toBe("BUDGET_SPENT");
  });

  it("records a PASS when the order goes out and fills nothing", async () => {
    dex.getWindows.mockResolvedValue([window("0xaaa")]);
    model.forecastWindow.mockResolvedValue(confident());
    dex.placeCall.mockResolvedValue({ txHash: "0xabc", filled: 0n });

    const run = await runAgent(opts());

    // An unfilled order is not a position, so it must not be logged as one.
    expect(run.placed).toBe(0);
    const row = recorded();
    expect(row["action"]).toBe("PASS");
    expect(row["txHash"]).toBeNull();
  });

  it("turns a window that locked mid-flight into WINDOW_CLOSING, not a crash", async () => {
    dex.getWindows.mockResolvedValue([window("0xaaa")]);
    model.forecastWindow.mockResolvedValue(confident());
    dex.placeCall.mockRejectedValue(new DexError("WINDOW_CLOSED", "locked"));

    const run = await runAgent(opts());

    expect(run.placed).toBe(0);
    expect(recorded()["passReason"]).toBe("WINDOW_CLOSING");
  });

  it("skips a window with too little life left to be worth a forecast", async () => {
    dex.getWindows.mockResolvedValue([window("0xaaa", "BTC", 20)]);
    const run = await runAgent(opts());
    expect(run.forecast).toBe(0);
    expect(model.forecastWindow).not.toHaveBeenCalled();
  });

  it("skips an untradable window", async () => {
    dex.getWindows.mockResolvedValue([{ ...window("0xaaa"), isTradable: false }]);
    await runAgent(opts());
    expect(model.forecastWindow).not.toHaveBeenCalled();
  });

  it("records nothing when the model returns no forecast", async () => {
    dex.getWindows.mockResolvedValue([window("0xaaa")]);
    model.forecastWindow.mockResolvedValue(null);

    const run = await runAgent(opts());

    expect(run.forecast).toBe(0);
    expect(store.recordForecast).not.toHaveBeenCalled();
    expect(dex.placeCall).not.toHaveBeenCalled();
  });

  it("survives a venue that cannot be read", async () => {
    dex.getWindows.mockRejectedValue(new Error("rpc down"));
    const run = await runAgent(opts());
    expect(run.considered).toBe(0);
    expect(run.notes.length).toBeGreaterThan(0);
  });

  it("survives a log write that fails, without claiming it recorded", async () => {
    dex.getWindows.mockResolvedValue([window("0xaaa")]);
    model.forecastWindow.mockResolvedValue(confident());
    store.recordForecast.mockRejectedValue(new Error("write failed"));

    const run = await runAgent(opts());

    expect(run.placed).toBe(1);
    expect(run.notes.some((n) => n.includes("log write failed"))).toBe(true);
  });

  it("takes the window closing soonest first", async () => {
    dex.getWindows.mockResolvedValue([
      window("0xlate", "BTC", 280),
      window("0xsoon", "BTC", 120),
    ]);
    model.forecastWindow.mockResolvedValue(confident());

    await runAgent({ ...opts(), maxForecasts: 1 });

    expect(recorded()["windowId"]).toBe("0xsoon");
  });
});
