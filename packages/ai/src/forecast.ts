/**
 * The model call. One request, one probability.
 *
 * Everything interesting about the forecaster lives elsewhere — the prompt is
 * pure (`prompt.ts`), the trade rule is pure (`decide.ts`), the backend choice
 * is its own module (`provider.ts`). This file is only the wire, and it is
 * written so that every failure mode ends in `null`: no provider configured, a
 * rate limit, a refusal, a malformed answer. A null forecast makes the agent
 * pass on that window, which is a state it is designed to be in anyway. The
 * forecaster never trades on a response it could not read.
 *
 * The request is provider-agnostic. Structured outputs, adaptive thinking and
 * effort are all GA on Vertex AI as well as the first-party API, so the same
 * body works on either and nothing here branches on the backend.
 */
import Anthropic from "@anthropic-ai/sdk";
import { FORECAST_SCHEMA, SYSTEM_PROMPT, buildPrompt, parseForecast, type WindowContext } from "./prompt";
import { activeProvider, createForecastClient, modelId, type ForecastClient, type Provider } from "./provider";
import type { Forecast } from "./types";

/**
 * Adaptive thinking on: the useful part of this task is weighing a weak base
 * rate against a market price, which is reasoning, not recall.
 *
 * Effort is `medium` rather than the default `high` deliberately. The call runs
 * inside a serverless function with a deadline, the judgement is genuinely
 * small, and a slower forecast is a missed window — the one failure that costs
 * more than a slightly worse estimate.
 */
const MAX_TOKENS = 8_000;

/** Generous enough for adaptive thinking, tight enough to fit a request. */
const TIMEOUT_MS = 25_000;

let cached: { client: ForecastClient; provider: Provider } | null = null;

/**
 * Is a provider configured?
 *
 * Exported so callers can degrade honestly. With neither backend set up the
 * site says the forecaster is offline rather than quietly showing nothing — an
 * empty AI page with no explanation reads as broken.
 */
export function isConfigured(): boolean {
  return activeProvider() !== null;
}

async function getClient(): Promise<{ client: ForecastClient; provider: Provider } | null> {
  if (cached) return cached;
  try {
    cached = await createForecastClient({ timeoutMs: TIMEOUT_MS, maxRetries: 1 });
  } catch (e) {
    // A misconfigured provider is a deployment mistake, not a transient fault.
    // Say so once; the forecaster then behaves exactly as if it were offline.
    console.error(`[ai] ${e instanceof Error ? e.message : "provider misconfigured"}`);
    return null;
  }
  return cached;
}

export interface ForecastResult {
  readonly forecast: Forecast;
  /** Tokens spent, for the cost line the AI page shows. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Which backend served it. */
  readonly provider: Provider;
}

/**
 * Ask the model for a probability on one window.
 *
 * Returns null rather than throwing. A forecast is optional by construction:
 * the site works without it, and the agent's default action is to do nothing.
 */
export async function forecastWindow(ctx: WindowContext): Promise<ForecastResult | null> {
  const active = await getClient();
  if (!active) return null;

  try {
    const response = await active.client.messages.create({
      model: modelId(),
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      thinking: { type: "adaptive" },
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: FORECAST_SCHEMA },
      },
      messages: [{ role: "user", content: buildPrompt(ctx) }],
    });

    // A safety decline is a valid outcome, not an exception. Pass the window.
    if (response.stop_reason === "refusal") return null;
    // Truncation means the JSON is incomplete; parsing it would be guesswork.
    if (response.stop_reason === "max_tokens") return null;

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (text.trim() === "") return null;

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return null;
    }

    const forecast = parseForecast(raw);
    if (!forecast) return null;

    return {
      forecast,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      provider: active.provider,
    };
  } catch (e) {
    // Typed, most specific first. Every branch ends the same way — no forecast,
    // so no trade — but the log distinguishes "we are rate limited" from
    // "the credentials are wrong", which are very different things to wake up
    // to. Both SDKs throw the same error classes, so this needs no branching.
    if (e instanceof Anthropic.AuthenticationError) {
      console.error(
        active.provider === "vertex"
          ? "[ai] Vertex rejected the Google credentials; forecaster is offline."
          : "[ai] ANTHROPIC_API_KEY rejected; forecaster is offline.",
      );
    } else if (e instanceof Anthropic.PermissionDeniedError) {
      // The characteristic Vertex failure: the project is real and the
      // credentials are valid, but this model is not enabled in this region.
      console.error(
        `[ai] permission denied for ${modelId()}. On Vertex, enable the model in ` +
          `Model Garden for this project and region, or set AI_MODEL to one you have.`,
      );
    } else if (e instanceof Anthropic.NotFoundError) {
      console.error(`[ai] ${modelId()} not found on this provider. Check AI_MODEL and the region.`);
    } else if (e instanceof Anthropic.RateLimitError) {
      console.warn("[ai] rate limited; skipping this window.");
    } else if (e instanceof Anthropic.APIConnectionError) {
      console.warn("[ai] could not reach the API; skipping this window.");
    } else if (e instanceof Anthropic.APIError) {
      console.warn(`[ai] API error ${e.status}: ${e.message}`);
    } else {
      console.warn("[ai] forecast failed:", e instanceof Error ? e.message : e);
    }
    return null;
  }
}
