/**
 * Which backend gets chosen, and how a service-account key is read.
 *
 * The credential path is the one piece of this that only fails in production:
 * locally it is covered by ADC, so a broken GOOGLE_SERVICE_ACCOUNT_JSON is
 * invisible until it is deployed. These tests are what stands in for that.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activeProvider, createForecastClient, describeProvider, modelId } from "../provider";

const KEYS = [
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
  "ANTHROPIC_API_KEY",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "AI_MODEL",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** A structurally valid service-account key. The private key is not a real one. */
const FAKE_SA = JSON.stringify({
  type: "service_account",
  project_id: "demo",
  client_email: "forecaster@demo.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nnotarealkey\n-----END PRIVATE KEY-----\n",
});

const opts = { timeoutMs: 1_000, maxRetries: 0 };

describe("activeProvider", () => {
  it("is null when nothing is configured", () => {
    expect(activeProvider()).toBeNull();
  });

  it("picks Vertex from a GCP project", () => {
    process.env["ANTHROPIC_VERTEX_PROJECT_ID"] = "demo";
    expect(activeProvider()).toBe("vertex");
  });

  it("picks the first-party API from a key", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
    expect(activeProvider()).toBe("anthropic");
  });

  it("prefers Vertex when both are set", () => {
    // A stale key left in the environment must not silently redirect spend
    // away from the provider the operator deliberately configured.
    process.env["ANTHROPIC_VERTEX_PROJECT_ID"] = "demo";
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
    expect(activeProvider()).toBe("vertex");
  });
});

describe("modelId", () => {
  it("defaults to Claude Opus 5", () => {
    expect(modelId()).toBe("claude-opus-5");
  });

  it("is overridable, because Vertex enablement is per project and region", () => {
    process.env["AI_MODEL"] = "claude-sonnet-5";
    expect(modelId()).toBe("claude-sonnet-5");
  });
});

describe("createForecastClient", () => {
  it("returns null with nothing configured", () => {
    expect(createForecastClient(opts)).toBeNull();
  });

  it("builds a first-party client from a key", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
    const made = createForecastClient(opts);
    expect(made?.provider).toBe("anthropic");
    expect(made?.client.messages).toBeDefined();
  });

  it("builds a Vertex client from a project, defaulting the region to global", () => {
    process.env["ANTHROPIC_VERTEX_PROJECT_ID"] = "demo";
    const made = createForecastClient(opts);
    expect(made?.provider).toBe("vertex");
    expect(made?.client.messages).toBeDefined();
  });

  it("accepts an inline service-account key", () => {
    process.env["ANTHROPIC_VERTEX_PROJECT_ID"] = "demo";
    process.env["GOOGLE_SERVICE_ACCOUNT_JSON"] = FAKE_SA;
    expect(createForecastClient(opts)?.provider).toBe("vertex");
  });

  it("accepts that key base64-encoded, since dashboards mangle embedded newlines", () => {
    process.env["ANTHROPIC_VERTEX_PROJECT_ID"] = "demo";
    process.env["GOOGLE_SERVICE_ACCOUNT_JSON"] = Buffer.from(FAKE_SA).toString("base64");
    expect(createForecastClient(opts)?.provider).toBe("vertex");
  });

  it("ignores an empty credential blob and falls through to ADC", () => {
    process.env["ANTHROPIC_VERTEX_PROJECT_ID"] = "demo";
    process.env["GOOGLE_SERVICE_ACCOUNT_JSON"] = "   ";
    expect(createForecastClient(opts)?.provider).toBe("vertex");
  });

  it("throws a legible error on an unparseable credential blob", () => {
    process.env["ANTHROPIC_VERTEX_PROJECT_ID"] = "demo";
    process.env["GOOGLE_SERVICE_ACCOUNT_JSON"] = "{not json";
    expect(() => createForecastClient(opts)).toThrow(/not valid JSON/);
  });

  it("rejects a blob that parses but is not a service-account key", () => {
    // The likely mistake: pasting an OAuth client or an API key instead.
    process.env["ANTHROPIC_VERTEX_PROJECT_ID"] = "demo";
    process.env["GOOGLE_SERVICE_ACCOUNT_JSON"] = JSON.stringify({ type: "authorized_user" });
    expect(() => createForecastClient(opts)).toThrow(/client_email/);
  });
});

describe("describeProvider", () => {
  it("names the project and region so a misconfiguration is visible", () => {
    process.env["ANTHROPIC_VERTEX_PROJECT_ID"] = "my-proj";
    process.env["CLOUD_ML_REGION"] = "us-east5";
    expect(describeProvider("vertex")).toBe("Vertex AI (my-proj · us-east5)");
  });

  it("says global when no region is pinned", () => {
    process.env["ANTHROPIC_VERTEX_PROJECT_ID"] = "my-proj";
    expect(describeProvider("vertex")).toContain("global");
  });

  it("names the first-party API", () => {
    expect(describeProvider("anthropic")).toBe("Claude API");
  });
});
