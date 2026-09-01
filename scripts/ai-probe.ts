/**
 * `pnpm ai:probe` — does the forecaster work?
 *
 * A one-shot dry run of the whole AI path against live windows: read the book,
 * build the prompt, call Gemini, apply the trade rule, print what it would do.
 * It signs nothing and writes nothing, so it is safe to run repeatedly while
 * tuning the threshold or checking a new key.
 *
 * This is the check to run FIRST after configuring a provider — Vertex AI or
 * the Gemini API. `pnpm smoke` proves the venue path; this proves the
 * forecaster on top of it, and reports which backend answered.
 *
 * Flags:
 *   --asset BTC|ETH   default BTC
 *   --count <n>       how many live windows to forecast (default 1)
 *   --prompt          print the exact prompt sent, then the answer
 */
import {
  getWindows, getTopOfBook, quoteCall, formatFixed, priceToPercent, headroomSecFor,
} from "@predictarena/dex";
import {
  forecastWindow, isConfigured, decide, buildPrompt, unitsToBps, MIN_EDGE_BPS,
  activeProvider, describeProvider, modelId,
  type WindowContext,
} from "@predictarena/ai";
import { createClientOrExit } from "./lib/env.js";
import { bold, dim, green, yellow, red, blue, heading, kv, info, describeError } from "./lib/log.js";

const ARGS = process.argv.slice(2);
const val = (f: string): string | undefined => {
  const i = ARGS.indexOf(f);
  return i >= 0 ? ARGS[i + 1] : undefined;
};
const SHOW_PROMPT = ARGS.includes("--prompt");
const ASSET = (val("--asset") ?? "BTC").toUpperCase();
const COUNT = Math.max(1, Math.min(5, Number(val("--count") ?? "1")));

/** Basis points as a percentage. Integers only: this sits beside a price. */
function pct(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = Math.abs(Math.round(bps % 100));
  return `${whole}.${String(frac).padStart(2, "0")}%`;
}

async function main(): Promise<void> {
  heading("AI forecaster probe");

  const provider = activeProvider();
  if (!isConfigured() || provider === null) {
    console.error(red("  No model provider is configured."));
    info("Set ONE of these in .env — see the AI forecaster block in .env.example:");
    info("  GOOGLE_CLOUD_PROJECT  (Vertex AI — plus ADC or GOOGLE_SERVICE_ACCOUNT_JSON)");
    info("  GEMINI_API_KEY        (Gemini API direct — https://aistudio.google.com/apikey)");
    process.exit(1);
  }

  kv("Provider", bold(describeProvider(provider)));
  kv("Model", modelId());
  if (provider === "vertex" && !process.env["GOOGLE_SERVICE_ACCOUNT_JSON"]) {
    // The commonest local failure by a mile, and the error it produces
    // otherwise ("Could not load the default credentials") explains nothing.
    info(dim("Using Application Default Credentials. If this fails, run:"));
    info(dim("  gcloud auth application-default login"));
  }

  const { client } = createClientOrExit();
  const decimals = client.collateral.decimals;

  info(`Reading live ${ASSET} windows...`);
  const windows = (await getWindows(client, { asset: ASSET, limit: 20 }))
    .filter((w) => w.isTradable && w.secondsLeft > headroomSecFor(w.intervalSec ?? 0))
    .sort((a, b) => a.secondsLeft - b.secondsLeft)
    .slice(0, COUNT);

  if (windows.length === 0) {
    console.error(yellow(`  No tradable ${ASSET} window right now.`));
    info("Try the other asset, or wait for the next window to open.");
    process.exit(1);
  }

  let wouldTrade = 0;

  for (const w of windows) {
    heading(`${w.asset} · ${Math.round(w.secondsLeft)}s left`);
    kv("Question", w.question);

    const book = await getTopOfBook(client, w.pool);
    kv(
      "Book",
      `Up ${book.up === null ? dim("none") : priceToPercent(book.up, decimals)} · ` +
        `Down ${book.down === null ? dim("none") : priceToPercent(book.down, decimals)}`,
    );

    const ctx: WindowContext = {
      asset: w.asset,
      question: w.question,
      intervalSec: w.intervalSec,
      secondsLeft: w.secondsLeft,
      askUpBps: book.up === null ? null : unitsToBps(book.up, decimals),
      askDownBps: book.down === null ? null : unitsToBps(book.down, decimals),
      // The probe deliberately sends no history: it is checking the wire and
      // the trade rule, not reproducing the agent's evidence exactly.
      history: [],
    };

    if (SHOW_PROMPT) {
      console.log(dim("\n--- prompt ---"));
      console.log(dim(buildPrompt(ctx)));
      console.log(dim("--- end ---\n"));
    }

    const started = Date.now();
    const result = await forecastWindow(ctx);
    const ms = Date.now() - started;

    if (!result) {
      console.error(red("  No forecast returned."));
      info("Look for an [ai] line above — it names the cause.");
      if (provider === "vertex") {
        info(
          `On Vertex, the usual causes are: the Vertex AI API not enabled on this project, ` +
            `the service account missing the "Vertex AI User" role, expired ADC, or ` +
            `${modelId()} not offered in this location.`,
        );
      }
      continue;
    }

    const f = result.forecast;
    kv("Estimate", `${bold(pct(f.probabilityUpBps))} Up · ${f.confidence} confidence · ${ms}ms`);
    kv("Rationale", f.rationale);
    if (f.keyFactors.length > 0) kv("Factors", f.keyFactors.join(", "));
    kv("Tokens", `${result.inputTokens} in / ${result.outputTokens} out · via ${result.provider}`);

    const decision = decide({ forecast: f, book, decimals });
    const edgeBps = unitsToBps(decision.edge, decimals);

    if (decision.kind === "PLACE") {
      wouldTrade += 1;
      console.log(
        `  ${green("WOULD PLACE")} ${bold(decision.side)} · edge ${green(`+${pct(edgeBps)}`)} ` +
          `over an ask of ${priceToPercent(decision.ask, decimals)}`,
      );
      // Price the order it would have sent, so a thin book shows up here rather
      // than as a surprise the first time the agent runs for real.
      try {
        const quote = await quoteCall(client, { window: w, direction: decision.side, stake: 1_000_000n });
        if (quote) {
          kv(
            "Would fill",
            `${formatFixed(quote.quantity, decimals, 4)} contracts for ` +
              `${formatFixed(quote.escrow, decimals, 4)} ${client.collateral.symbol}`,
          );
        } else {
          console.log(`  ${yellow("...but nothing is resting to fill against.")}`);
        }
      } catch (e) {
        console.log(`  ${yellow(`...but quoting failed: ${describeError(e)}`)}`);
      }
    } else {
      console.log(
        `  ${blue("WOULD PASS")} · ${decision.reason}` +
          (decision.side ? ` · best edge ${pct(edgeBps)} on ${decision.side}` : ""),
      );
    }
  }

  heading("Result");
  kv("Windows probed", String(windows.length));
  kv("Would trade", `${wouldTrade} of ${windows.length}`);
  info(
    `The threshold is ${pct(MIN_EDGE_BPS)} of edge, widened for a less confident estimate. ` +
      `Passing is the expected outcome most of the time.`,
  );
  console.log(
    green(`\n  Forecaster is working on ${describeProvider(provider)}. Nothing was signed or written.\n`),
  );
}

main().catch((e) => {
  console.error(red(`\n  ${describeError(e)}\n`));
  process.exit(1);
});
