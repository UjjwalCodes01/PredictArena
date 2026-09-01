/**
 * Which backend serves the forecaster, and how it authenticates.
 *
 * Kept apart from `forecast.ts` so the provider choice is a small, readable,
 * separately testable decision rather than a branch buried in the request. The
 * request itself is identical either way: after construction both clients
 * expose the same `messages.create` surface, and every feature the forecaster
 * uses — structured outputs, adaptive thinking, effort — is GA on both.
 *
 * Two providers, chosen from the environment:
 *
 *   Vertex AI  — Claude through Google Cloud. Selected when a GCP project is
 *                configured. Billed and rate-limited by Google.
 *   Claude API — the first-party API, selected by ANTHROPIC_API_KEY.
 *
 * Vertex wins when both are set: it is the more deliberate configuration, and
 * a stale key left in the environment should not silently redirect spend.
 */
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { GoogleAuth } from "google-auth-library";

export type Provider = "vertex" | "anthropic";

/**
 * The client the forecaster holds.
 *
 * A union rather than a shared interface: the two SDKs are not structurally
 * identical — the Vertex client's `messages` omits the Batch API, which Vertex
 * does not have — but `messages.create` is the same call on both, and that is
 * the entire surface the forecaster uses.
 */
export type ForecastClient = Anthropic | AnthropicVertex;

/** Vertex needs this scope; the SDK's own default sets it too. */
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/**
 * Which provider is configured, if any.
 *
 * Returns null when neither is, which is a supported state everywhere: the
 * site runs without a forecaster and says so.
 */
export function activeProvider(): Provider | null {
  if (process.env["ANTHROPIC_VERTEX_PROJECT_ID"]) return "vertex";
  if (process.env["ANTHROPIC_API_KEY"]) return "anthropic";
  return null;
}

/**
 * The model to ask for.
 *
 * Overridable because Vertex model availability is per project and per region —
 * a model enabled in one GCP project may simply not exist in another, and that
 * is a deployment fact rather than a code change. Vertex uses the same bare
 * model id as the first-party API for current-generation models.
 */
export function modelId(): string {
  return process.env["AI_MODEL"] ?? "claude-opus-5";
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
function serviceAccountAuth(): GoogleAuth | undefined {
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

  return new GoogleAuth({ credentials, scopes: CLOUD_PLATFORM_SCOPE });
}

/**
 * Build the client for whichever provider is configured.
 *
 * Returns null when none is. Throws only when a provider is configured but
 * configured WRONGLY — a bad service-account blob is a deployment mistake worth
 * surfacing loudly, unlike a missing key, which is a legitimate state.
 */
export function createForecastClient(opts: {
  timeoutMs: number;
  maxRetries: number;
}): { client: ForecastClient; provider: Provider } | null {
  const provider = activeProvider();
  if (provider === null) return null;

  if (provider === "vertex") {
    const auth = serviceAccountAuth();
    const client = new AnthropicVertex({
      // Both read their own env vars when omitted, but passing them explicitly
      // keeps the failure legible: a missing region here is a clear message
      // rather than a 404 against a URL built from an empty string.
      projectId: process.env["ANTHROPIC_VERTEX_PROJECT_ID"] as string,
      region: process.env["CLOUD_ML_REGION"] ?? "global",
      timeout: opts.timeoutMs,
      maxRetries: opts.maxRetries,
      ...(auth ? { googleAuth: auth } : {}),
    });
    return { client, provider };
  }

  return {
    client: new Anthropic({ timeout: opts.timeoutMs, maxRetries: opts.maxRetries }),
    provider,
  };
}

/** Human-readable, for the probe and the AI page. */
export function describeProvider(provider: Provider): string {
  if (provider === "vertex") {
    const region = process.env["CLOUD_ML_REGION"] ?? "global";
    const project = process.env["ANTHROPIC_VERTEX_PROJECT_ID"] ?? "?";
    return `Vertex AI (${project} · ${region})`;
  }
  return "Claude API";
}
