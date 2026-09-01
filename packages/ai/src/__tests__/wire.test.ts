/**
 * The request, on the wire.
 *
 * The prompt and the trade rule are tested purely elsewhere. What is left, and
 * what nothing else covers, is that the request we actually send carries the
 * things the forecaster depends on: the strict JSON contract, the system
 * prompt, and dynamic thinking. Drop any of those silently and the forecaster
 * still "works" while quietly getting worse.
 *
 * Pinned against a real local HTTP server rather than a mocked SDK, so the
 * SDK's own serialisation is included in what is checked. No credentials: the
 * API-key path needs no Google auth, and `httpOptions.baseUrl` points it here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { GoogleGenAI } from "@google/genai";
import { FORECAST_SCHEMA, SYSTEM_PROMPT, buildPrompt, parseForecast } from "../prompt";

interface Captured {
  path: string;
  body: Record<string, unknown>;
}

let server: Server;
let baseUrl: string;
let captured: Captured | null = null;

/** What the API returns for a well-formed answer. */
const CANNED = {
  candidates: [
    {
      content: {
        role: "model",
        parts: [
          {
            text: JSON.stringify({
              probabilityUpBps: 6_400,
              confidence: "MEDIUM",
              rationale: "Slight lean up on a thin book.",
              keyFactors: ["base rate"],
            }),
          },
        ],
      },
      finishReason: "STOP",
    },
  ],
  usageMetadata: { promptTokenCount: 420, candidatesTokenCount: 95, thoughtsTokenCount: 260 },
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += String(c); });
    req.on("end", () => {
      captured = {
        path: req.url ?? "",
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(CANNED));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function send() {
  captured = null;
  const ai = new GoogleGenAI({ apiKey: "test-key", httpOptions: { baseUrl } });
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: buildPrompt({
      asset: "BTC",
      question: "Will BTC close above its opening price?",
      intervalSec: 300,
      secondsLeft: 200,
      askUpBps: 5_500,
      askDownBps: 4_700,
      history: [],
    }),
    config: {
      systemInstruction: SYSTEM_PROMPT,
      responseMimeType: "application/json",
      responseJsonSchema: FORECAST_SCHEMA,
      thinkingConfig: { thinkingBudget: -1 },
      maxOutputTokens: 8_000,
    },
  });
  return { captured: captured as unknown as Captured, response };
}

describe("Gemini request", () => {
  it("names the model in the path", async () => {
    const { captured } = await send();
    expect(captured.path).toContain("gemini-2.5-flash");
    expect(captured.path).toContain("generateContent");
  });

  it("carries the system prompt", async () => {
    const { captured } = await send();
    // Its most important instruction — that near-50% is a correct answer —
    // must survive serialisation, or the model reaches for confident numbers.
    expect(JSON.stringify(captured.body)).toContain("near 50%");
  });

  it("sends the strict JSON contract, not just a request for JSON", async () => {
    const { captured } = await send();
    const config = captured.body["generationConfig"] as Record<string, unknown> | undefined;
    expect(config?.["responseMimeType"]).toBe("application/json");

    const schema = config?.["responseJsonSchema"] as Record<string, unknown> | undefined;
    expect(schema).toBeDefined();
    expect(schema?.["additionalProperties"]).toBe(false);
    expect(schema?.["required"]).toContain("probabilityUpBps");
  });

  it("asks for dynamic thinking rather than a fixed or disabled budget", async () => {
    const { captured } = await send();
    const config = captured.body["generationConfig"] as Record<string, unknown> | undefined;
    const thinking = config?.["thinkingConfig"] as Record<string, unknown> | undefined;
    // 0 would disable thinking outright; a fixed number would overspend on the
    // easy windows and underspend on the hard ones.
    expect(thinking?.["thinkingBudget"]).toBe(-1);
  });

  it("returns an answer the validator accepts", async () => {
    const { response } = await send();
    const forecast = parseForecast(JSON.parse(response.text ?? ""));
    expect(forecast).not.toBeNull();
    expect(forecast?.probabilityUpBps).toBe(6_400);
  });

  it("reports thinking tokens as part of what the call cost", async () => {
    const { response } = await send();
    // Thinking is billed. Counting only the visible answer would understate
    // the cost the AI page reports by roughly three times here.
    const usage = response.usageMetadata;
    expect(usage?.promptTokenCount).toBe(420);
    expect((usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0)).toBe(355);
  });
});
