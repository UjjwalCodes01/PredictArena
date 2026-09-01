/**
 * The Vertex request, on the wire.
 *
 * Everything else about the move to Vertex is shared with the first-party
 * path — same request body, same response handling, same SDK error classes.
 * The one genuinely Vertex-specific thing that can silently be wrong is the
 * URL: project, region and model are interpolated into the path, so a bad
 * region or a stale model id produces a 404 against a plausible-looking
 * endpoint rather than a clear error.
 *
 * This pins that shape without needing Google credentials. A stub `authClient`
 * stands in for Google OAuth — the SDK only ever asks it for `projectId` and
 * `getRequestHeaders()` — and a stub `fetch` captures the outgoing request.
 * (Note `accessToken` alone is NOT enough: the client still resolves an auth
 * client on every request, so without this it falls through to ADC.)
 */
import { describe, expect, it } from "vitest";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import type { AuthClient } from "google-auth-library";
import { FORECAST_SCHEMA, SYSTEM_PROMPT, buildPrompt } from "../prompt";
import { parseForecast } from "../prompt";

/** A well-formed answer, shaped as the Messages API returns it. */
const CANNED = {
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-opus-5",
  content: [
    {
      type: "text",
      text: JSON.stringify({
        probabilityUpBps: 6_400,
        confidence: "MEDIUM",
        rationale: "Slight lean up on a thin book.",
        keyFactors: ["base rate"],
      }),
    },
  ],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 420, output_tokens: 95 },
};

/** Derived from `fetch` itself: the root tsconfig has no DOM lib. */
type FetchArgs = Parameters<typeof fetch>;

function stubFetch(captured: { url?: string; body?: Record<string, unknown> }) {
  return async (url: FetchArgs[0], init?: FetchArgs[1]): Promise<Response> => {
    captured.url = String(url);
    captured.body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    return new Response(JSON.stringify(CANNED), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

async function callVertex(opts: { region: string; project: string; model: string }) {
  const captured: { url?: string; body?: Record<string, unknown> } = {};
  const client = new AnthropicVertex({
    projectId: opts.project,
    region: opts.region,
    // Stands in for Google OAuth. The SDK uses exactly these two members.
    authClient: {
      projectId: opts.project,
      getRequestHeaders: async () => new Headers({ authorization: "Bearer fake-token" }),
    } as unknown as AuthClient,
    fetch: stubFetch(captured) as unknown as typeof fetch,
    maxRetries: 0,
  });

  const response = await client.messages.create({
    model: opts.model,
    max_tokens: 8_000,
    system: SYSTEM_PROMPT,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: FORECAST_SCHEMA },
    },
    messages: [
      {
        role: "user",
        content: buildPrompt({
          asset: "BTC",
          question: "Will BTC close above its opening price?",
          intervalSec: 300,
          secondsLeft: 200,
          askUpBps: 5_500,
          askDownBps: 4_700,
          history: [],
        }),
      },
    ],
  });

  return { captured, response };
}

describe("Vertex request", () => {
  it("targets the project, region and model in the URL path", async () => {
    const { captured } = await callVertex({
      region: "us-east5",
      project: "my-project",
      model: "claude-opus-5",
    });

    expect(captured.url).toContain("us-east5-aiplatform.googleapis.com");
    expect(captured.url).toContain("/projects/my-project/");
    expect(captured.url).toContain("/locations/us-east5/");
    expect(captured.url).toContain("/publishers/anthropic/models/claude-opus-5");
  });

  it("honours the global endpoint", async () => {
    const { captured } = await callVertex({
      region: "global",
      project: "my-project",
      model: "claude-opus-5",
    });
    expect(captured.url).toContain("/locations/global/");
  });

  it("carries the model in the path, not the body", async () => {
    // Vertex routes by URL. A model left in the body is silently ignored by
    // some backends and rejected by others — either way the request would not
    // do what it looks like it does.
    const { captured } = await callVertex({
      region: "global",
      project: "p",
      model: "claude-opus-5",
    });
    expect(captured.body?.["model"]).toBeUndefined();
    expect(captured.url).toContain("models/claude-opus-5");
  });

  it("sends adaptive thinking and the strict JSON schema", async () => {
    const { captured } = await callVertex({ region: "global", project: "p", model: "claude-opus-5" });

    expect(captured.body?.["thinking"]).toEqual({ type: "adaptive" });
    const outputConfig = captured.body?.["output_config"] as Record<string, unknown>;
    expect(outputConfig?.["effort"]).toBe("medium");
    const format = outputConfig?.["format"] as Record<string, unknown>;
    expect(format?.["type"]).toBe("json_schema");
    expect((format?.["schema"] as Record<string, unknown>)?.["additionalProperties"]).toBe(false);
  });

  it("returns an answer the validator accepts", async () => {
    const { response } = await callVertex({ region: "global", project: "p", model: "claude-opus-5" });

    const text = response.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
    const forecast = parseForecast(JSON.parse(text));

    expect(forecast).not.toBeNull();
    expect(forecast?.probabilityUpBps).toBe(6_400);
    expect(response.usage.input_tokens).toBe(420);
  });
});
