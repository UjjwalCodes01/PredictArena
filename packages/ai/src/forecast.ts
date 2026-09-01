/**
 * The model call. One request, one probability.
 *
 * Everything interesting about the forecaster lives elsewhere — the prompt is
 * pure (`prompt.ts`), the trade rule is pure (`decide.ts`), the backend choice
 * is its own module (`provider.ts`). This file is only the wire, and it is
 * written so that every failure mode ends in `null`: no provider configured, a
 * rate limit, a safety block, a malformed answer. A null forecast makes the
 * agent pass on that window, which is a state it is designed to be in anyway.
 * The forecaster never trades on a response it could not read.
 *
 * The request is provider-agnostic: Vertex AI and the Gemini API take the same
 * body, so nothing here branches on the backend except the error message.
 */
import { ApiError, FinishReason } from "@google/genai";
import { FORECAST_SCHEMA, SYSTEM_PROMPT, buildPrompt, parseForecast, type WindowContext } from "./prompt";
import { activeProvider, createForecastClient, modelId, type ForecastClient, type Provider } from "./provider";
import type { Forecast } from "./types";

/**
 * Enough room for a short JSON answer plus the thinking that precedes it.
 * Thinking tokens count against this, so it is not sized to the answer alone.
 */
const MAX_OUTPUT_TOKENS = 8_000;

/** Generous enough for dynamic thinking, tight enough to fit inside a request. */
const TIMEOUT_MS = 25_000;

/**
 * Dynamic thinking: -1 lets the model decide how much to spend, which is the
 * right setting for a judgement whose difficulty varies window to window. 0
 * would disable it entirely and 
 * a fixed budget would overspend on the easy ones.
 */
const THINKING_BUDGET_DYNAMIC = -1;

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

function getClient(): { client: ForecastClient; provider: Provider } | null {
  if (cached) return cached;
  try {
    cached = createForecastClient();
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
  const active = getClient();
  if (!active) return null;

  try {
    const response = await active.client.models.generateContent({
      model: modelId(),
      contents: buildPrompt(ctx),
      config: {
        systemInstruction: SYSTEM_PROMPT,
        // Structured output. `responseJsonSchema` takes an ordinary JSON Schema,
        // so the same strict contract the validator checks is the one the model
        // is held to — no second, drifting copy of the shape.
        responseMimeType: "application/json",
        responseJsonSchema: FORECAST_SCHEMA,
        thinkingConfig: { thinkingBudget: THINKING_BUDGET_DYNAMIC },
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      },
    });

    const finish = response.candidates?.[0]?.finishReason;
    // A safety block or a recitation stop is a valid outcome, not an exception.
    // Truncation means the JSON is incomplete, and parsing it would be guesswork.
    if (
      finish === FinishReason.SAFETY ||
      finish === FinishReason.RECITATION ||
      finish === FinishReason.MAX_TOKENS
    ) {
      return null;
    }

    // `.text` concatenates the text parts and excludes thought parts, which is
    // exactly the JSON we asked for.
    const text = response.text;
    if (!text || text.trim() === "") return null;

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return null;
    }

    const forecast = parseForecast(raw);
    if (!forecast) return null;

    const usage = response.usageMetadata;
    return {
      forecast,
      inputTokens: usage?.promptTokenCount ?? 0,
      // Thinking is billed and is genuinely part of what this cost, so it is
      // counted rather than quietly dropped from the figure the page shows.
      outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
      provider: active.provider,
    };
  } catch (e) {
    // Every branch ends the same way — no forecast, so no trade — but the log
    // distinguishes "we are rate limited" from "the credentials are wrong",
    // which are very different things to wake up to.
    if (e instanceof ApiError) {
      if (e.status === 401 || e.status === 403) {
        console.error(
          active.provider === "vertex"
            ? `[ai] Vertex rejected the credentials, or ${modelId()} is not enabled for this ` +
                "project and location. Check the service account has the Vertex AI User role."
            : "[ai] GEMINI_API_KEY was rejected; forecaster is offline.",
        );
      } else if (e.status === 404) {
        console.error(`[ai] ${modelId()} not found on this provider. Check AI_MODEL and the location.`);
      } else if (e.status === 429) {
        console.warn("[ai] rate limited; skipping this window.");
      } else {
        console.warn(`[ai] API error ${e.status}: ${e.message}`);
      }
    } else if (e instanceof Error && e.name === "TimeoutError") {
      console.warn("[ai] the model did not answer inside the deadline; skipping this window.");
    } else {
      console.warn("[ai] forecast failed:", e instanceof Error ? e.message : e);
    }
    return null;
  }
}
