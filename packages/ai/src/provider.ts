/**
 * Which backend serves the forecaster, and how it authenticates.
 *
 * Kept apart from `forecast.ts` so the provider choice is a small, readable,
 * separately testable decision rather than a branch buried in the request. The
 * request itself is identical either way: after construction both paths expose
 * the same `models.generateContent` surface.
 *
 * Two providers, chosen from the environment:
 *
 *   Vertex AI  — Gemini through Google Cloud. Selected when a GCP project is
 *                configured. Billed and rate-limited by Google Cloud.
 *   Gemini API — the direct Gemini Developer API, selected by GEMINI_API_KEY.
 *                Needs no GCP project at all.
 *
 * Vertex wins when both are set: it is the more deliberate configuration, and a
 * stale key left in the environment should not silently redirect spend.
 *
 * The variable names are Google's own (`GOOGLE_CLOUD_PROJECT`,
 * `GOOGLE_CLOUD_LOCATION`, `GEMINI_API_KEY`) rather than names of our
 * invention, because the SDK already reads exactly these.
 */
import { GoogleGenAI } from "@google/genai";
import type { GoogleAuthOptions } from "google-auth-library";

export type Provider = "vertex" | "gemini-api";

/** The client the forecaster holds. One SDK serves both providers. */
export type ForecastClient = GoogleGenAI;

/**
 * Which provider is configured, if any.
 *
 * Returns null when neither is, which is a supported state everywhere: the
 * site runs without a forecaster and says so.
 */
export function activeProvider(): Provider | null {
  if (process.env["GOOGLE_CLOUD_PROJECT"]) return "vertex";
  if (process.env["GEMINI_API_KEY"]) return "gemini-api";
  return null;
}

/**
 * The model to ask for.
 *
 * Flash rather than Pro by default, and that is a considered trade. The call
 * runs inside a serverless function against a window that closes, so a slower
 * forecast is a MISSED forecast — the one failure that costs more than a
 * slightly worse estimate. The judgement itself is small: weigh a weak base
 * rate against a market price. Set AI_MODEL to a Pro model if you would rather
 * spend the latency.
 *
 * Overridable also because availability differs by project and region, which is
 * a deployment fact rather than a code change.
 */
export function modelId(): string {
  return process.env["AI_MODEL"] ?? "gemini-2.5-flash";
}

/**
 * Google credentials for a runtime with no gcloud and no metadata server.
 *
 * Application Default Credentials cover local development
 * (`gcloud auth application-default login`) and Google-hosted compute, but a
 * serverless function on Vercel has neither: no CLI, no metadata endpoint, and
 * a read-only filesystem that makes GOOGLE_APPLICATION_CREDENTIALS — which
 * wants a FILE PATH — useless there.
 *
 * So a service-account key may be supplied inline as JSON. Returning undefined
 * falls through to ADC, which is the right behaviour locally.
 */
export function serviceAccountCredentials(): GoogleAuthOptions | undefined {
  const raw = process.env["GOOGLE_SERVICE_ACCOUNT_JSON"];
  if (!raw || raw.trim() === "") return undefined;

  let credentials: Record<string, unknown>;
  try {
    // Tolerate a base64-wrapped value: some dashboards mangle raw JSON with
    // embedded newlines, and the private key in a service account is full of
    // them. Detected by shape rather than by a second env var to set wrongly.
    const text = raw.trim().startsWith("{")
      ? raw
      : Buffer.from(raw, "base64").toString("utf8");
    credentials = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON is set but is not valid JSON (or base64-encoded JSON). " +
        "Paste the whole service-account key file, or its base64 encoding.",
    );
  }

  if (typeof credentials["client_email"] !== "string" || typeof credentials["private_key"] !== "string") {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON parsed but has no client_email/private_key. " +
        "It should be a service-account key, not an OAuth client or an API key.",
    );
  }

  return { credentials };
}

/**
 * Build the client for whichever provider is configured.
 *
 * Returns null when none is. Throws only when a provider is configured but
 * configured WRONGLY — a bad service-account blob is a deployment mistake worth
 * surfacing, unlike a missing key, which is a legitimate state.
 *
 * Synchronous because this SDK resolves credentials LAZILY, on first request —
 * verified, not assumed. A credential failure therefore arrives as an ordinary
 * rejection from `generateContent`, which `forecast.ts` already catches, rather
 * than as an unhandled rejection from a promise created in the constructor.
 */
export function createForecastClient(): { client: ForecastClient; provider: Provider } | null {
  const provider = activeProvider();
  if (provider === null) return null;

  if (provider === "vertex") {
    const auth = serviceAccountCredentials();
    return {
      client: new GoogleGenAI({
        vertexai: true,
        // The SDK reads these itself when omitted, but passing them explicitly
        // keeps a failure legible: a missing project here is a clear message
        // rather than a 404 against a URL built from an empty string.
        project: process.env["GOOGLE_CLOUD_PROJECT"] as string,
        location: process.env["GOOGLE_CLOUD_LOCATION"] ?? "global",
        ...(auth ? { googleAuthOptions: auth } : {}),
      }),
      provider,
    };
  }

  return {
    client: new GoogleGenAI({ apiKey: process.env["GEMINI_API_KEY"] as string }),
    provider,
  };
}

/** Human-readable, for the probe and the AI page. */
export function describeProvider(provider: Provider): string {
  if (provider === "vertex") {
    const location = process.env["GOOGLE_CLOUD_LOCATION"] ?? "global";
    const project = process.env["GOOGLE_CLOUD_PROJECT"] ?? "?";
    return `Vertex AI (${project} · ${location})`;
  }
  return "Gemini API";
}
